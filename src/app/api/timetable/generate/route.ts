import { NextRequest, NextResponse } from 'next/server';
import { getDb, uuid } from '@/lib/db';

/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║  OptiSchedule — Scored CSP Timetable Generator          ║
 * ║                                                          ║
 * ║  Algorithm: Constraint Satisfaction Problem (CSP) with   ║
 * ║  scored slot selection + post-generation optimization    ║
 * ║                                                          ║
 * ║  Phases:                                                 ║
 * ║  1. Labs (most constrained, spread across days)          ║
 * ║  2. Theory (scored placement: day spread, time pref,     ║
 * ║     anti-clustering, faculty availability)               ║
 * ║  3. Free periods (strategic fill)                        ║
 * ║  4. Optimization (swap slots to improve quality)         ║
 * ╚══════════════════════════════════════════════════════════╝
 */

interface SubjectRow { id: string; name: string; type: string; hours_per_week: number; lab_type_id: string | null; }
interface FacultyAssignmentRow { faculty_id: string; subject_id: string; faculty_name?: string; }
interface FreePeriodInput { name: string; periods_per_week: number; }

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const PERIOD_TIMES = [
    { period: 1, start: '9:00 AM', end: '9:50 AM' },
    { period: 2, start: '9:50 AM', end: '10:40 AM' },
    { period: 3, start: '11:00 AM', end: '11:50 AM' },
    { period: 4, start: '11:50 AM', end: '12:40 PM' },
    { period: 5, start: '1:50 PM', end: '2:40 PM' },
    { period: 6, start: '2:40 PM', end: '3:30 PM' },
    { period: 7, start: '3:30 PM', end: '4:20 PM' },
];

// ========================
// SCORING WEIGHTS
// ========================
const SCORE = {
    DAY_SPREAD: 50,           // Strongly prefer days where this subject hasn't been placed
    NO_REPEAT_SAME_DAY: -100, // Heavy penalty for same subject again on same day
    TIME_PREFERENCE: 15,      // Theory prefers morning (P1-4), labs prefer afternoon (P5-7)
    ANTI_CLUSTER: 10,         // Avoid same subject in adjacent periods
    EVEN_DISTRIBUTION: 8,     // Balance periods across days
    FACULTY_FRESH: 5,         // Faculty hasn't had many classes today
    ROOM_CONSISTENCY: 3,      // Same room for same section
};

interface SubjectReq {
    id: string; name: string; type: string;
    remaining: number; labTypeId?: string | null; isFree?: boolean;
}

interface Assignment {
    class_id: string; day: string; period: number;
    subject_id: string; subject_name: string;
    room_id?: string; lab_id?: string; faculty_id?: string;
    is_free?: boolean;
}

interface ClassInfo {
    classId: string; year: number; sectionLabel: string;
    requirements: SubjectReq[]; facultyAssignments: FacultyAssignmentRow[];
    labDayCount: Record<string, number>;
}

export async function POST(request: NextRequest) {
    try {
        const config = await request.json();
        const {
            class_ids,
            selected_room_ids = [] as string[],
            selected_lab_ids = [] as string[],
            free_periods = [] as FreePeriodInput[],
            periods_per_day = 7,
            max_consecutive_theory = 3,
            lab_consecutive_periods = 2,
        } = config;

        if (!class_ids || class_ids.length === 0) return NextResponse.json({ error: 'Select at least one class' }, { status: 400 });

        const db = getDb();
        const conflicts: string[] = [];
        const classIdSet = new Set(class_ids as string[]);

        // ============================================
        // LOAD EXISTING GLOBAL STATE
        // ============================================
        const roomBusy: Record<string, Set<string>> = {};
        const labBusy: Record<string, Set<string>> = {};
        const facultyBusy: Record<string, Set<string>> = {};

        for (const rs of db.prepare('SELECT room_id, day, period, class_id FROM room_schedule').all() as { room_id: string; day: string; period: number; class_id: string }[]) {
            if (classIdSet.has(rs.class_id)) continue;
            roomBusy[rs.room_id] = roomBusy[rs.room_id] || new Set();
            roomBusy[rs.room_id].add(`${rs.day}_${rs.period}`);
        }
        for (const ls of db.prepare('SELECT lab_id, day, period, class_id FROM lab_schedule').all() as { lab_id: string; day: string; period: number; class_id: string }[]) {
            if (classIdSet.has(ls.class_id)) continue;
            labBusy[ls.lab_id] = labBusy[ls.lab_id] || new Set();
            labBusy[ls.lab_id].add(`${ls.day}_${ls.period}`);
        }
        for (const fs of db.prepare('SELECT faculty_id, day, period, class_id FROM faculty_schedule').all() as { faculty_id: string; day: string; period: number; class_id: string }[]) {
            if (classIdSet.has(fs.class_id)) continue;
            facultyBusy[fs.faculty_id] = facultyBusy[fs.faculty_id] || new Set();
            facultyBusy[fs.faculty_id].add(`${fs.day}_${fs.period}`);
        }

        // ============================================
        // BUILD CLASS INFO
        // ============================================
        const classInfos: ClassInfo[] = [];
        for (const classId of class_ids) {
            const cls = db.prepare('SELECT year, section_id, department_id FROM classes WHERE id = ?').get(classId) as { year: number; section_id: string; department_id: string } | undefined;
            if (!cls) { conflicts.push(`Class ${classId} not found`); continue; }
            const sec = db.prepare('SELECT section_name FROM sections WHERE id = ?').get(cls.section_id) as { section_name: string } | undefined;
            const sectionLabel = sec ? `Y${cls.year}-${sec.section_name}` : classId;

            const subjects = db.prepare('SELECT id, name, type, hours_per_week, lab_type_id FROM subjects WHERE department_id = ?').all(cls.department_id) as SubjectRow[];
            if (subjects.length === 0) { conflicts.push(`No subjects for ${sectionLabel}`); continue; }

            const fa = db.prepare('SELECT fa.faculty_id, fa.subject_id, p.name as faculty_name FROM faculty_assignments fa LEFT JOIN profiles p ON fa.faculty_id = p.id WHERE fa.class_id = ?').all(classId) as FacultyAssignmentRow[];

            const requirements: SubjectReq[] = subjects.map(s => ({
                id: s.id, name: s.name, type: s.type, remaining: s.hours_per_week, labTypeId: s.lab_type_id,
            }));
            for (const fp of free_periods) {
                // Create actual subject entry for free period so name persists in queries
                let freeSubj = db.prepare("SELECT id FROM subjects WHERE name = ? AND type = 'free' AND department_id = ?").get(fp.name, cls.department_id) as { id: string } | undefined;
                if (!freeSubj) {
                    const freeId = uuid();
                    db.prepare('INSERT INTO subjects (id, name, type, hours_per_week, department_id) VALUES (?, ?, ?, ?, ?)').run(freeId, fp.name, 'free', fp.periods_per_week, cls.department_id);
                    freeSubj = { id: freeId };
                }
                requirements.push({ id: freeSubj.id, name: fp.name, type: 'free', remaining: fp.periods_per_week, isFree: true });
            }

            classInfos.push({ classId, year: cls.year, sectionLabel, requirements, facultyAssignments: fa, labDayCount: {} });
        }

        const allAssignments: Assignment[] = [];
        const classSlotUsed: Record<string, Set<string>> = {};
        for (const ci of classInfos) classSlotUsed[ci.classId] = new Set();

        // Valid lab start periods (can't span breaks)
        const validLabStarts: number[] = [];
        for (let s = 1; s <= periods_per_day - lab_consecutive_periods + 1; s++) {
            const end = s + lab_consecutive_periods - 1;
            if (s <= 2 && end >= 3) continue; // break between P2-P3
            if (s <= 4 && end >= 5) continue; // lunch between P4-P5
            validLabStarts.push(s);
        }

        // ============================================
        // HELPER: Score a slot for a subject
        // ============================================
        function scoreSlot(ci: ClassInfo, subj: SubjectReq, day: string, period: number): number {
            let score = 0;

            // 1. Day spread — how many times is this subject already on this day?
            const sameDayCount = allAssignments.filter(a => a.class_id === ci.classId && a.day === day && a.subject_id === subj.id).length;
            if (sameDayCount === 0) score += SCORE.DAY_SPREAD;
            else score += SCORE.NO_REPEAT_SAME_DAY * sameDayCount;

            // 2. Time preference — theory prefers morning, labs prefer afternoon
            if (subj.type === 'theory') {
                if (period <= 4) score += SCORE.TIME_PREFERENCE;
                else score += Math.floor(SCORE.TIME_PREFERENCE * 0.3);
            }

            // 3. Anti-clustering — avoid adjacent same subject
            const prevSame = allAssignments.find(a => a.class_id === ci.classId && a.day === day && a.period === period - 1 && a.subject_id === subj.id);
            const nextSame = allAssignments.find(a => a.class_id === ci.classId && a.day === day && a.period === period + 1 && a.subject_id === subj.id);
            if (!prevSame && !nextSame) score += SCORE.ANTI_CLUSTER;
            if (prevSame) score -= SCORE.ANTI_CLUSTER * 2;

            // 4. Even distribution — prefer days with fewer total classes for this section
            const dayTotal = allAssignments.filter(a => a.class_id === ci.classId && a.day === day).length;
            score += SCORE.EVEN_DISTRIBUTION * (periods_per_day - dayTotal);

            // 5. Faculty freshness — fewer classes for this faculty today = better
            const faculty = ci.facultyAssignments.find(fa => fa.subject_id === subj.id);
            if (faculty) {
                const facultyDayLoad = allAssignments.filter(a => a.day === day && a.faculty_id === faculty.faculty_id).length;
                score += SCORE.FACULTY_FRESH * Math.max(0, 4 - facultyDayLoad);
            }

            // 6. Room consistency — prefer the room this section used before
            if (selected_room_ids.length > 0) {
                const prevRoom = allAssignments.find(a => a.class_id === ci.classId && a.room_id);
                if (prevRoom?.room_id && !roomBusy[prevRoom.room_id]?.has(`${day}_${period}`)) {
                    score += SCORE.ROOM_CONSISTENCY;
                }
            }

            return score;
        }

        // ============================================
        // PHASE 1: LABS (spread across days, scored)
        // ============================================
        // Interleave lab scheduling across sections
        const allLabReqs: { ci: ClassInfo; subj: SubjectReq }[] = [];
        for (const ci of classInfos) {
            for (const subj of ci.requirements.filter(r => r.type === 'lab' && r.remaining > 0)) {
                allLabReqs.push({ ci, subj });
            }
        }
        // Sort by hours (more constrained first)
        allLabReqs.sort((a, b) => b.subj.remaining - a.subj.remaining);

        for (const { ci, subj } of allLabReqs) {
            const neededBlocks = Math.ceil(subj.remaining / lab_consecutive_periods);
            const faculty = ci.facultyAssignments.find(fa => fa.subject_id === subj.id);

            for (let block = 0; block < neededBlocks; block++) {
                // Score all valid (day, startPeriod) combos
                interface LabOption { day: string; startP: number; labId?: string; score: number; }
                const options: LabOption[] = [];

                for (const day of DAYS) {
                    for (const startP of validLabStarts) {
                        // Check section slots free
                        let free = true;
                        for (let o = 0; o < lab_consecutive_periods; o++) {
                            if (classSlotUsed[ci.classId].has(`${day}_${startP + o}`)) { free = false; break; }
                        }
                        if (!free) continue;

                        // Faculty check
                        if (faculty) {
                            let fFree = true;
                            for (let o = 0; o < lab_consecutive_periods; o++) {
                                if (facultyBusy[faculty.faculty_id]?.has(`${day}_${startP + o}`)) { fFree = false; break; }
                            }
                            if (!fFree) continue;
                        }

                        // Find available lab
                        let labId: string | undefined;
                        for (const lid of selected_lab_ids) {
                            let lFree = true;
                            for (let o = 0; o < lab_consecutive_periods; o++) {
                                if (labBusy[lid]?.has(`${day}_${startP + o}`)) { lFree = false; break; }
                            }
                            if (lFree) { labId = lid; break; }
                        }
                        if (!labId && selected_lab_ids.length > 0) continue;

                        // Score
                        let score = 0;
                        // Spread labs across days
                        const labsOnDay = ci.labDayCount[day] || 0;
                        score += 40 * (3 - labsOnDay);
                        // Prefer afternoon for labs
                        if (startP >= 5) score += 20;
                        else if (startP >= 3) score += 10;
                        // Avoid day overload
                        const dayLoad = allAssignments.filter(a => a.class_id === ci.classId && a.day === day).length;
                        score += 5 * (periods_per_day - dayLoad);
                        // Interleave: if another section has lab on this day, slight penalty
                        const otherLabsSameDay = allAssignments.filter(a => a.day === day && a.lab_id && a.class_id !== ci.classId).length;
                        score -= otherLabsSameDay * 5;

                        options.push({ day, startP, labId, score });
                    }
                }

                // Pick best option
                options.sort((a, b) => b.score - a.score);
                const best = options[0];

                if (best) {
                    for (let offset = 0; offset < lab_consecutive_periods; offset++) {
                        const p = best.startP + offset;
                        const sk = `${best.day}_${p}`;
                        classSlotUsed[ci.classId].add(sk);
                        const a: Assignment = { class_id: ci.classId, day: best.day, period: p, subject_id: subj.id, subject_name: subj.name };
                        if (best.labId) { a.lab_id = best.labId; labBusy[best.labId] = labBusy[best.labId] || new Set(); labBusy[best.labId].add(sk); }
                        if (faculty) { a.faculty_id = faculty.faculty_id; facultyBusy[faculty.faculty_id] = facultyBusy[faculty.faculty_id] || new Set(); facultyBusy[faculty.faculty_id].add(sk); }
                        allAssignments.push(a);
                    }
                    subj.remaining -= lab_consecutive_periods;
                    ci.labDayCount[best.day] = (ci.labDayCount[best.day] || 0) + 1;
                } else {
                    conflicts.push(`Could not place lab "${subj.name}" block ${block + 1} for ${ci.sectionLabel}`);
                }
            }
        }

        // ============================================
        // PHASE 2: THEORY (scored slot selection)
        // ============================================
        // Process theory subjects in order: most hours first (most constrained)
        for (const ci of classInfos) {
            const theoryReqs = ci.requirements.filter(r => r.type === 'theory' && r.remaining > 0);
            theoryReqs.sort((a, b) => b.remaining - a.remaining);

            for (const subj of theoryReqs) {
                while (subj.remaining > 0) {
                    // Score ALL valid slots
                    interface SlotOption { day: string; period: number; roomId?: string; score: number; }
                    const options: SlotOption[] = [];

                    for (const day of DAYS) {
                        for (let p = 1; p <= periods_per_day; p++) {
                            const sk = `${day}_${p}`;
                            if (classSlotUsed[ci.classId].has(sk)) continue;

                            // Faculty check
                            const faculty = ci.facultyAssignments.find(fa => fa.subject_id === subj.id);
                            if (faculty && facultyBusy[faculty.faculty_id]?.has(sk)) continue;

                            // Consecutive theory check (reset at breaks)
                            let consecutive = 0;
                            for (let check = p - 1; check >= 1; check--) {
                                if (check === 2 || check === 4) break;
                                const prev = allAssignments.find(a => a.class_id === ci.classId && a.day === day && a.period === check);
                                if (!prev) break;
                                if (!prev.is_free && !prev.lab_id) consecutive++; else break;
                            }
                            if (consecutive >= max_consecutive_theory) continue;

                            // Find room
                            let roomId: string | undefined;
                            // Prefer room this section used before
                            const prevRoomAssignment = allAssignments.find(a => a.class_id === ci.classId && a.room_id);
                            if (prevRoomAssignment?.room_id && !roomBusy[prevRoomAssignment.room_id]?.has(sk)) {
                                roomId = prevRoomAssignment.room_id;
                            } else {
                                for (const rid of selected_room_ids) {
                                    if (!roomBusy[rid]?.has(sk)) { roomId = rid; break; }
                                }
                            }

                            const score = scoreSlot(ci, subj, day, p) + (roomId ? 5 : -20);
                            options.push({ day, period: p, roomId, score });
                        }
                    }

                    // Pick best slot
                    options.sort((a, b) => b.score - a.score);
                    const best = options[0];

                    if (best) {
                        const sk = `${best.day}_${best.period}`;
                        classSlotUsed[ci.classId].add(sk);
                        const faculty = ci.facultyAssignments.find(fa => fa.subject_id === subj.id);
                        const a: Assignment = { class_id: ci.classId, day: best.day, period: best.period, subject_id: subj.id, subject_name: subj.name };
                        if (best.roomId) { a.room_id = best.roomId; roomBusy[best.roomId] = roomBusy[best.roomId] || new Set(); roomBusy[best.roomId].add(sk); }
                        if (faculty) { a.faculty_id = faculty.faculty_id; facultyBusy[faculty.faculty_id] = facultyBusy[faculty.faculty_id] || new Set(); facultyBusy[faculty.faculty_id].add(sk); }
                        allAssignments.push(a);
                        subj.remaining--;
                    } else {
                        conflicts.push(`Could not place "${subj.name}" for ${ci.sectionLabel}`);
                        break;
                    }
                }
            }
        }

        // ============================================
        // PHASE 3: FREE PERIODS (strategic fill)
        // ============================================
        for (const ci of classInfos) {
            const freeReqs = ci.requirements.filter(r => r.isFree && r.remaining > 0);
            for (const fp of freeReqs) {
                while (fp.remaining > 0) {
                    // Score slots for free periods: prefer days with most classes (give a break)
                    interface FreeOption { day: string; period: number; score: number; }
                    const options: FreeOption[] = [];

                    for (const day of DAYS) {
                        for (let p = 1; p <= periods_per_day; p++) {
                            const sk = `${day}_${p}`;
                            if (classSlotUsed[ci.classId].has(sk)) continue;

                            let score = 0;
                            // Spread free periods evenly
                            const freeOnDay = allAssignments.filter(a => a.class_id === ci.classId && a.day === day && a.is_free).length;
                            score += 30 * (2 - freeOnDay);
                            // Same free period not on same day
                            const sameFreeOnDay = allAssignments.filter(a => a.class_id === ci.classId && a.day === day && a.subject_id === fp.id).length;
                            if (sameFreeOnDay === 0) score += 40;
                            else score -= 50;
                            // Prefer last periods of the day
                            score += p * 3;
                            options.push({ day, period: p, score });
                        }
                    }

                    options.sort((a, b) => b.score - a.score);
                    const best = options[0];

                    if (best) {
                        classSlotUsed[ci.classId].add(`${best.day}_${best.period}`);
                        allAssignments.push({ class_id: ci.classId, day: best.day, period: best.period, subject_id: fp.id, subject_name: fp.name, is_free: true });
                        fp.remaining--;
                    } else {
                        conflicts.push(`Could not place "${fp.name}" for ${ci.sectionLabel}`);
                        break;
                    }
                }
            }
        }

        // ============================================
        // PHASE 4: OPTIMIZATION (swap to improve)
        // ============================================
        // Try swapping slots within each section to improve quality
        const MAX_SWAPS = 200;
        let improvements = 0;

        for (let iter = 0; iter < MAX_SWAPS; iter++) {
            let improved = false;

            for (const ci of classInfos) {
                const myAssignments = allAssignments.filter(a => a.class_id === ci.classId && !a.lab_id && !a.is_free);
                if (myAssignments.length < 2) continue;

                // Try random swap
                const i = Math.floor(Math.random() * myAssignments.length);
                const j = Math.floor(Math.random() * myAssignments.length);
                if (i === j) continue;
                const a1 = myAssignments[i];
                const a2 = myAssignments[j];

                // Check if swap is valid (faculty constraints)
                const f1 = ci.facultyAssignments.find(fa => fa.subject_id === a1.subject_id);
                const f2 = ci.facultyAssignments.find(fa => fa.subject_id === a2.subject_id);
                if (f1 && f1.faculty_id !== a1.faculty_id) continue;
                if (f2 && f2.faculty_id !== a2.faculty_id) continue;

                // Check faculty availability after swap
                const sk1 = `${a1.day}_${a1.period}`;
                const sk2 = `${a2.day}_${a2.period}`;
                if (f1 && f1.faculty_id !== f2?.faculty_id && facultyBusy[f1.faculty_id]?.has(sk2)) continue;
                if (f2 && f2.faculty_id !== f1?.faculty_id && facultyBusy[f2.faculty_id]?.has(sk1)) continue;

                // Score before and after
                const s1 = a1.subject_id === a2.subject_id ? { id: a1.subject_id, name: a1.subject_name, type: 'theory', remaining: 0 } : { id: a1.subject_id, name: a1.subject_name, type: 'theory', remaining: 0 };
                const s2 = { id: a2.subject_id, name: a2.subject_name, type: 'theory', remaining: 0 };
                const scoreBefore = scoreSlot(ci, s1, a1.day, a1.period) + scoreSlot(ci, s2, a2.day, a2.period);
                const scoreAfter = scoreSlot(ci, s1, a2.day, a2.period) + scoreSlot(ci, s2, a1.day, a1.period);

                if (scoreAfter > scoreBefore) {
                    // Perform swap
                    const tmpDay = a1.day; const tmpPeriod = a1.period; const tmpRoom = a1.room_id;
                    a1.day = a2.day; a1.period = a2.period; a1.room_id = a2.room_id;
                    a2.day = tmpDay; a2.period = tmpPeriod; a2.room_id = tmpRoom;

                    // Update faculty busy maps
                    if (f1 && f1.faculty_id !== f2?.faculty_id) {
                        facultyBusy[f1.faculty_id]?.delete(sk1);
                        facultyBusy[f1.faculty_id] = facultyBusy[f1.faculty_id] || new Set();
                        facultyBusy[f1.faculty_id].add(sk2);
                    }
                    if (f2 && f2.faculty_id !== f1?.faculty_id) {
                        facultyBusy[f2.faculty_id]?.delete(sk2);
                        facultyBusy[f2.faculty_id] = facultyBusy[f2.faculty_id] || new Set();
                        facultyBusy[f2.faculty_id].add(sk1);
                    }

                    improvements++;
                    improved = true;
                }
            }
            if (!improved && iter > 50) break; // Converged
        }

        // ============================================
        // SAVE TO DATABASE
        // ============================================
        if (allAssignments.length > 0) {
            for (const cid of class_ids) {
                db.prepare('DELETE FROM timetables WHERE class_id = ?').run(cid);
                db.prepare('DELETE FROM faculty_schedule WHERE class_id = ?').run(cid);
                db.prepare('DELETE FROM room_schedule WHERE class_id = ?').run(cid);
                db.prepare('DELETE FROM lab_schedule WHERE class_id = ?').run(cid);
            }
            const insertTT = db.prepare('INSERT INTO timetables (id, class_id, day, period, subject_id, room_id, lab_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
            const insertFS = db.prepare('INSERT INTO faculty_schedule (id, faculty_id, day, period, class_id, subject_id) VALUES (?, ?, ?, ?, ?, ?)');
            const insertRS = db.prepare('INSERT INTO room_schedule (id, room_id, day, period, class_id) VALUES (?, ?, ?, ?, ?)');
            const insertLS = db.prepare('INSERT INTO lab_schedule (id, lab_id, day, period, class_id) VALUES (?, ?, ?, ?, ?)');

            db.transaction(() => {
                for (const a of allAssignments) {
                    const sid = a.subject_id;
                    insertTT.run(uuid(), a.class_id, a.day, a.period, sid, a.room_id || null, a.lab_id || null);
                    if (a.faculty_id) insertFS.run(uuid(), a.faculty_id, a.day, a.period, a.class_id, sid);
                    if (a.room_id) insertRS.run(uuid(), a.room_id, a.day, a.period, a.class_id);
                    if (a.lab_id) insertLS.run(uuid(), a.lab_id, a.day, a.period, a.class_id);
                }
            })();
        }

        return NextResponse.json({
            success: true,
            message: `Generated for ${class_ids.length} class(es)`,
            total_slots: allAssignments.length,
            period_times: PERIOD_TIMES,
            algorithm: 'Scored CSP with optimization',
            optimizations: improvements,
            conflicts: conflicts.length > 0 ? conflicts : undefined,
        });
    } catch (error) {
        console.error('Generation error:', error);
        return NextResponse.json({ error: 'Generation failed: ' + (error as Error).message }, { status: 500 });
    }
}
