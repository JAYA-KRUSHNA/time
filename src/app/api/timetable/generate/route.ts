import { NextRequest, NextResponse } from 'next/server';
import { getDb, uuid } from '@/lib/db';

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  OptiSchedule — Production CSP Timetable Generator v2.0     ║
 * ║                                                              ║
 * ║  Algorithm: Constraint Satisfaction Problem (CSP)            ║
 * ║  + MRV heuristic + scored placement + simulated annealing   ║
 * ║                                                              ║
 * ║  6 Hard Constraints (strictly zero violations):              ║
 * ║  H1. No faculty double-booking across all classes            ║
 * ║  H2. No room double-booking across all classes               ║
 * ║  H3. No lab double-booking across all classes                ║
 * ║  H4. Faculty availability matrix strictly respected          ║
 * ║  H5. Room type must match subject type (theory↔theory)       ║
 * ║  H6. Room capacity ≥ section student count                   ║
 * ║                                                              ║
 * ║  Soft Constraints (optimized via scoring + annealing):       ║
 * ║  S1. Spread same subject across different days               ║
 * ║  S2. Avoid >3 consecutive periods for same faculty           ║
 * ║  S3. Prefer morning slots for theory subjects                ║
 * ║  S4. Minimize room switching per class per day               ║
 * ║  S5. Even subject distribution across the week               ║
 * ║  S6. Avoid back-to-back lab blocks from different subjects   ║
 * ║  S7. Balanced faculty daily load                             ║
 * ║                                                              ║
 * ║  5 Phases: Labs → Theory → Free → Force-fill → Anneal       ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

// ─── Types ───────────────────────────────────────────────────
interface SubjectRow { id: string; name: string; type: string; hours_per_week: number; lab_type_id: string | null; }
interface FacultyAssignmentRow { faculty_id: string; subject_id: string; faculty_name: string; }
interface FacultyInterestRow { faculty_id: string; subject_id: string; faculty_name: string; subject_name: string; subject_type: string; created_at: string; }
interface FreePeriodInput { name: string; periods_per_week: number; }

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
    studentCount: number;
    requirements: SubjectReq[]; facultyAssignments: FacultyAssignmentRow[];
    labDayCount: Record<string, number>;
}

// ─── Constants ───────────────────────────────────────────────
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

// Break boundaries: periods 2→3 has short break, periods 4→5 has lunch
// Labs must NOT span across these breaks
const BREAK_AFTER_PERIOD = new Set([2, 4]);

// ─── Scoring weights ────────────────────────────────────────
const W = {
    SUBJECT_DAY_SPREAD: 60,       // Reward placing subject on new day
    SUBJECT_REPEAT_SAME_DAY: -120, // Penalize same subject twice on same day
    MORNING_THEORY: 18,           // Theory in morning (P1-P4) preferred
    ANTI_CLUSTER: 12,             // Avoid same subject consecutive periods
    EVEN_DAY_LOAD: 10,            // Balance load across days
    FACULTY_LOAD_BALANCE: 8,      // Avoid overloading faculty on one day
    ROOM_CONSISTENCY: 6,          // Same room for same class → less switching
    ROOM_AVAILABLE: 5,            // Bonus if a room is available
    NO_ROOM_PENALTY: -15,         // Penalty if no room can be found
};

// ─── O(1) Index for fast lookups ─────────────────────────────
class ScheduleIndex {
    // slotKey = "day_period"
    private classSlots = new Map<string, Set<string>>();           // classId → set of slotKeys
    private facultySlots = new Map<string, Set<string>>();         // facultyId → set of slotKeys
    private roomSlots = new Map<string, Set<string>>();            // roomId → set of slotKeys
    private labSlots = new Map<string, Set<string>>();             // labId → set of slotKeys
    private classDaySubject = new Map<string, number>();           // "classId|day|subjectId" → count
    private classDayLoad = new Map<string, number>();              // "classId|day" → count
    private facultyDayLoad = new Map<string, number>();            // "facultyId|day" → count
    private classDayRooms = new Map<string, Set<string>>();        // "classId|day" → set of roomIds
    private classDayFreePeriods = new Map<string, number>();       // "classId|day" → free period count
    private classPrevRoom = new Map<string, string>();             // classId → last used roomId

    isClassSlotUsed(classId: string, sk: string): boolean {
        return this.classSlots.get(classId)?.has(sk) ?? false;
    }

    isFacultyBusy(facultyId: string, sk: string): boolean {
        return this.facultySlots.get(facultyId)?.has(sk) ?? false;
    }

    isRoomBusy(roomId: string, sk: string): boolean {
        return this.roomSlots.get(roomId)?.has(sk) ?? false;
    }

    isLabBusy(labId: string, sk: string): boolean {
        return this.labSlots.get(labId)?.has(sk) ?? false;
    }

    getClassDaySubjectCount(classId: string, day: string, subjectId: string): number {
        return this.classDaySubject.get(`${classId}|${day}|${subjectId}`) ?? 0;
    }

    getClassDayLoad(classId: string, day: string): number {
        return this.classDayLoad.get(`${classId}|${day}`) ?? 0;
    }

    getFacultyDayLoad(facultyId: string, day: string): number {
        return this.facultyDayLoad.get(`${facultyId}|${day}`) ?? 0;
    }

    getClassDayRoomCount(classId: string, day: string): number {
        return this.classDayRooms.get(`${classId}|${day}`)?.size ?? 0;
    }

    getClassPrevRoom(classId: string): string | undefined {
        return this.classPrevRoom.get(classId);
    }

    getClassDayFreeCount(classId: string, day: string): number {
        return this.classDayFreePeriods.get(`${classId}|${day}`) ?? 0;
    }

    addAssignment(a: Assignment) {
        const sk = `${a.day}_${a.period}`;

        // Class slot
        if (!this.classSlots.has(a.class_id)) this.classSlots.set(a.class_id, new Set());
        this.classSlots.get(a.class_id)!.add(sk);

        // Faculty
        if (a.faculty_id) {
            if (!this.facultySlots.has(a.faculty_id)) this.facultySlots.set(a.faculty_id, new Set());
            this.facultySlots.get(a.faculty_id)!.add(sk);
            const fdk = `${a.faculty_id}|${a.day}`;
            this.facultyDayLoad.set(fdk, (this.facultyDayLoad.get(fdk) ?? 0) + 1);
        }

        // Room
        if (a.room_id) {
            if (!this.roomSlots.has(a.room_id)) this.roomSlots.set(a.room_id, new Set());
            this.roomSlots.get(a.room_id)!.add(sk);
            const cdk = `${a.class_id}|${a.day}`;
            if (!this.classDayRooms.has(cdk)) this.classDayRooms.set(cdk, new Set());
            this.classDayRooms.get(cdk)!.add(a.room_id);
            this.classPrevRoom.set(a.class_id, a.room_id);
        }

        // Lab
        if (a.lab_id) {
            if (!this.labSlots.has(a.lab_id)) this.labSlots.set(a.lab_id, new Set());
            this.labSlots.get(a.lab_id)!.add(sk);
        }

        // Subject per day
        const sdk = `${a.class_id}|${a.day}|${a.subject_id}`;
        this.classDaySubject.set(sdk, (this.classDaySubject.get(sdk) ?? 0) + 1);

        // Day load
        const dlk = `${a.class_id}|${a.day}`;
        this.classDayLoad.set(dlk, (this.classDayLoad.get(dlk) ?? 0) + 1);

        // Free periods
        if (a.is_free) {
            const fck = `${a.class_id}|${a.day}`;
            this.classDayFreePeriods.set(fck, (this.classDayFreePeriods.get(fck) ?? 0) + 1);
        }
    }

    removeAssignment(a: Assignment) {
        const sk = `${a.day}_${a.period}`;
        this.classSlots.get(a.class_id)?.delete(sk);
        if (a.faculty_id) {
            this.facultySlots.get(a.faculty_id)?.delete(sk);
            const fdk = `${a.faculty_id}|${a.day}`;
            const v = this.facultyDayLoad.get(fdk);
            if (v) this.facultyDayLoad.set(fdk, v - 1);
        }
        if (a.room_id) {
            this.roomSlots.get(a.room_id)?.delete(sk);
        }
        if (a.lab_id) {
            this.labSlots.get(a.lab_id)?.delete(sk);
        }
        const sdk = `${a.class_id}|${a.day}|${a.subject_id}`;
        const sc = this.classDaySubject.get(sdk);
        if (sc) this.classDaySubject.set(sdk, sc - 1);
        const dlk = `${a.class_id}|${a.day}`;
        const dl = this.classDayLoad.get(dlk);
        if (dl) this.classDayLoad.set(dlk, dl - 1);
    }

    // Seed from existing DB schedules (for classes NOT being regenerated)
    seedExisting(
        roomSchedule: { room_id: string; day: string; period: number }[],
        labSchedule: { lab_id: string; day: string; period: number }[],
        facultySchedule: { faculty_id: string; day: string; period: number }[],
    ) {
        for (const rs of roomSchedule) {
            const sk = `${rs.day}_${rs.period}`;
            if (!this.roomSlots.has(rs.room_id)) this.roomSlots.set(rs.room_id, new Set());
            this.roomSlots.get(rs.room_id)!.add(sk);
        }
        for (const ls of labSchedule) {
            const sk = `${ls.day}_${ls.period}`;
            if (!this.labSlots.has(ls.lab_id)) this.labSlots.set(ls.lab_id, new Set());
            this.labSlots.get(ls.lab_id)!.add(sk);
        }
        for (const fs of facultySchedule) {
            const sk = `${fs.day}_${fs.period}`;
            if (!this.facultySlots.has(fs.faculty_id)) this.facultySlots.set(fs.faculty_id, new Set());
            this.facultySlots.get(fs.faculty_id)!.add(sk);
            const fdk = `${fs.faculty_id}|${fs.day}`;
            this.facultyDayLoad.set(fdk, (this.facultyDayLoad.get(fdk) ?? 0) + 1);
        }
    }
}

// ─── Concurrency lock (with TTL so it auto-expires) ──────────
function acquireLock(db: ReturnType<typeof getDb>): boolean {
    try {
        // Auto-release stale locks older than 2 minutes
        db.prepare("DELETE FROM data_change_tracker WHERE id = 'generation_lock' AND last_changed < datetime('now', '-2 minutes')").run();
        const lock = db.prepare("SELECT id FROM data_change_tracker WHERE id = 'generation_lock'").get();
        if (lock) return false;
        db.prepare("INSERT INTO data_change_tracker (id, table_name, last_changed) VALUES ('generation_lock', 'lock', datetime('now'))").run();
        return true;
    } catch { return false; }
}

function releaseLock(db: ReturnType<typeof getDb>) {
    try { db.prepare("DELETE FROM data_change_tracker WHERE id = 'generation_lock'").run(); } catch { /* ignore */ }
}

// ─── Main Handler ────────────────────────────────────────────
export async function POST(request: NextRequest) {
    const startTime = performance.now();
    const db = getDb();

    if (!acquireLock(db)) {
        return NextResponse.json({ error: 'Another generation is in progress. Please wait.' }, { status: 429 });
    }

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

        if (!class_ids || class_ids.length === 0) {
            releaseLock(db);
            return NextResponse.json({ error: 'Select at least one class' }, { status: 400 });
        }

        const conflicts: string[] = [];
        const classIdSet = new Set(class_ids as string[]);

        // ═══════════════════════════════════════════
        // LOAD HARD CONSTRAINT DATA
        // ═══════════════════════════════════════════

        // Faculty unavailability matrix
        const facultyUnavailable = new Map<string, Set<string>>();
        const availRows = db.prepare('SELECT faculty_id, day, period FROM faculty_availability WHERE is_available = 0').all() as { faculty_id: string; day: string; period: number }[];
        for (const row of availRows) {
            if (!facultyUnavailable.has(row.faculty_id)) facultyUnavailable.set(row.faculty_id, new Set());
            facultyUnavailable.get(row.faculty_id)!.add(`${row.day}_${row.period}`);
        }

        // Room info (capacity + type)
        const roomInfo = new Map<string, { capacity: number; type: string }>();
        for (const rid of selected_room_ids) {
            const r = db.prepare('SELECT capacity, type FROM rooms WHERE id = ?').get(rid) as { capacity: number; type: string } | undefined;
            if (r) roomInfo.set(rid, { capacity: r.capacity, type: r.type || 'theory' });
        }

        // Lab info (capacity + type matching)
        const labInfo = new Map<string, { capacity: number; labTypeId: string | null }>();
        for (const lid of selected_lab_ids) {
            const l = db.prepare('SELECT capacity, lab_type_id FROM labs WHERE id = ?').get(lid) as { capacity: number; lab_type_id: string | null } | undefined;
            if (l) labInfo.set(lid, { capacity: l.capacity, labTypeId: l.lab_type_id });
        }

        // ═══════════════════════════════════════════
        // BUILD SCHEDULE INDEX (O(1) lookups)
        // ═══════════════════════════════════════════
        const idx = new ScheduleIndex();

        // Seed existing schedules from classes NOT being regenerated
        const existingRooms = db.prepare('SELECT room_id, day, period, class_id FROM room_schedule').all() as { room_id: string; day: string; period: number; class_id: string }[];
        const existingLabs = db.prepare('SELECT lab_id, day, period, class_id FROM lab_schedule').all() as { lab_id: string; day: string; period: number; class_id: string }[];
        const existingFaculty = db.prepare('SELECT faculty_id, day, period, class_id FROM faculty_schedule').all() as { faculty_id: string; day: string; period: number; class_id: string }[];

        idx.seedExisting(
            existingRooms.filter(r => !classIdSet.has(r.class_id)),
            existingLabs.filter(l => !classIdSet.has(l.class_id)),
            existingFaculty.filter(f => !classIdSet.has(f.class_id)),
        );

        // Initialize class slot sets for target classes
        for (const cid of class_ids) {
            // Touch to ensure the set exists even if empty
            idx.isClassSlotUsed(cid, 'init');
        }

        // ═══════════════════════════════════════════
        // LOAD ALL FACULTY INTERESTS (FCFS order)
        // ═══════════════════════════════════════════
        const allInterests = db.prepare(`
            SELECT fs.faculty_id, fs.subject_id, p.name as faculty_name,
                   s.name as subject_name, s.type as subject_type,
                   COALESCE(fs.created_at, datetime('now')) as created_at
            FROM faculty_subjects fs
            JOIN profiles p ON fs.faculty_id = p.id
            JOIN subjects s ON fs.subject_id = s.id
            WHERE p.status = 'active'
            ORDER BY fs.created_at ASC
        `).all() as FacultyInterestRow[];

        // All active faculty (fallback pool)
        const allFaculty = db.prepare("SELECT id, name FROM profiles WHERE role = 'faculty' AND status = 'active'").all() as { id: string; name: string }[];

        // Track: which subjects each faculty is assigned to per year (R5: no multi-subject per year)
        // Key: "facultyId|year" → Set of subject *names* (not IDs, so lab+theory of same subject count as one)
        const facultyYearSubjects = new Map<string, Set<string>>();
        // Track: which sections each faculty is assigned to per year (R8: prefer single section)
        const facultyYearSections = new Map<string, Set<string>>();
        // Track: total assignments per faculty (for load balancing)
        const facultyTotalLoad = new Map<string, number>();

        // ═══════════════════════════════════════════
        // BUILD CLASS INFO
        // ═══════════════════════════════════════════
        const classInfos: ClassInfo[] = [];
        for (const classId of class_ids) {
            const cls = db.prepare('SELECT year, section_id, department_id FROM classes WHERE id = ?').get(classId) as { year: number; section_id: string; department_id: string } | undefined;
            if (!cls) { conflicts.push(`Class ${classId} not found`); continue; }
            const sec = db.prepare('SELECT section_name, student_count FROM sections WHERE id = ?').get(cls.section_id) as { section_name: string; student_count: number } | undefined;
            const sectionLabel = sec ? `Y${cls.year}-${sec.section_name}` : classId;
            const sectionName = sec?.section_name || classId;
            const studentCount = sec?.student_count || 0;

            const subjects = db.prepare("SELECT id, name, type, hours_per_week, lab_type_id FROM subjects WHERE department_id = ? AND type != 'free'").all(cls.department_id) as SubjectRow[];
            if (subjects.length === 0 && free_periods.length === 0) { conflicts.push(`No subjects for ${sectionLabel}`); continue; }

            const requirements: SubjectReq[] = subjects.map(s => ({
                id: s.id, name: s.name, type: s.type, remaining: s.hours_per_week, labTypeId: s.lab_type_id,
            }));

            // Add free periods
            for (const fp of free_periods) {
                let freeSubj = db.prepare("SELECT id FROM subjects WHERE name = ? AND type = 'free' AND department_id = ?").get(fp.name, cls.department_id) as { id: string } | undefined;
                if (!freeSubj) {
                    const freeId = uuid();
                    db.prepare('INSERT INTO subjects (id, name, type, hours_per_week, department_id) VALUES (?, ?, ?, ?, ?)').run(freeId, fp.name, 'free', fp.periods_per_week, cls.department_id);
                    freeSubj = { id: freeId };
                }
                requirements.push({ id: freeSubj.id, name: fp.name, type: 'free', remaining: fp.periods_per_week, isFree: true });
            }

            // Cap total requirements to available slots
            const totalSlots = periods_per_day * DAYS.length;
            let totalRequired = requirements.reduce((sum, r) => sum + r.remaining, 0);
            if (totalRequired > totalSlots) {
                conflicts.push(`${sectionLabel}: ${totalRequired} periods needed but only ${totalSlots} slots available.`);
                const scale = totalSlots / totalRequired;
                for (const r of requirements) r.remaining = Math.max(1, Math.round(r.remaining * scale));
            }

            // ═══════════════════════════════════════════
            // PHASE 0: AUTO-ASSIGN FACULTY FROM INTERESTS
            // ═══════════════════════════════════════════
            const autoFacultyAssignments: FacultyAssignmentRow[] = [];

            for (const subj of requirements) {
                if (subj.isFree) continue; // No faculty for free periods

                // 1. Find interested faculty for this subject (FCFS order via created_at)
                const interested = allInterests.filter(i => i.subject_id === subj.id);

                // 2. Filter candidates by constraints
                const validCandidates: { faculty_id: string; faculty_name: string; score: number }[] = [];

                for (const cand of interested) {
                    const fyk = `${cand.faculty_id}|${cls.year}`;
                    const existingSubjects = facultyYearSubjects.get(fyk) || new Set();

                    // R5: Faculty can't teach multiple DIFFERENT subjects for same year
                    // R7: Exception — same subject name as lab+theory is OK (e.g., DBMS lab + DBMS theory)
                    const subjectBaseName = subj.name.replace(/\s*(lab|theory|practical)\s*/gi, '').trim().toLowerCase();
                    const hasConflictingSubject = [...existingSubjects].some(existingName => {
                        const existingBase = existingName.replace(/\s*(lab|theory|practical)\s*/gi, '').trim().toLowerCase();
                        return existingBase !== subjectBaseName;
                    });
                    if (hasConflictingSubject) continue;

                    // Score: prefer faculty not yet in another section of same year (R8)
                    let score = 100; // base interest score
                    const existingSections = facultyYearSections.get(fyk) || new Set();
                    if (existingSections.size > 0 && !existingSections.has(sectionName)) {
                        score -= 50; // Penalize multi-section, but don't block
                    }

                    // Prefer faculty with lower total load
                    const load = facultyTotalLoad.get(cand.faculty_id) || 0;
                    score -= load * 2;

                    validCandidates.push({ faculty_id: cand.faculty_id, faculty_name: cand.faculty_name, score });
                }

                // 3. If >3 interested, take top 3 by FCFS (already ordered), then pick best score
                let selected: { faculty_id: string; faculty_name: string } | null = null;
                if (validCandidates.length > 0) {
                    // Take first 3 (FCFS order preserved from allInterests)
                    const top3 = validCandidates.slice(0, 3);
                    // Pick the one with highest score
                    top3.sort((a, b) => b.score - a.score);
                    selected = top3[0];
                }

                // 4. Fallback: if no interested faculty, assign any available faculty
                if (!selected) {
                    for (const fac of allFaculty) {
                        const fyk = `${fac.id}|${cls.year}`;
                        const existingSubjects = facultyYearSubjects.get(fyk) || new Set();
                        const subjectBaseName = subj.name.replace(/\s*(lab|theory|practical)\s*/gi, '').trim().toLowerCase();
                        const hasConflict = [...existingSubjects].some(en => {
                            return en.replace(/\s*(lab|theory|practical)\s*/gi, '').trim().toLowerCase() !== subjectBaseName;
                        });
                        if (hasConflict) continue;

                        const existingSections = facultyYearSections.get(fyk) || new Set();
                        if (existingSections.size > 0 && !existingSections.has(sectionName)) continue;

                        selected = { faculty_id: fac.id, faculty_name: fac.name };
                        break;
                    }
                }

                if (selected) {
                    autoFacultyAssignments.push({
                        faculty_id: selected.faculty_id,
                        subject_id: subj.id,
                        faculty_name: selected.faculty_name,
                    });

                    // Update tracking maps
                    const fyk = `${selected.faculty_id}|${cls.year}`;
                    if (!facultyYearSubjects.has(fyk)) facultyYearSubjects.set(fyk, new Set());
                    facultyYearSubjects.get(fyk)!.add(subj.name);
                    if (!facultyYearSections.has(fyk)) facultyYearSections.set(fyk, new Set());
                    facultyYearSections.get(fyk)!.add(sectionName);
                    facultyTotalLoad.set(selected.faculty_id, (facultyTotalLoad.get(selected.faculty_id) || 0) + subj.remaining);
                } else {
                    conflicts.push(`No faculty available for "${subj.name}" in ${sectionLabel}`);
                }
            }

            // Save auto-assignments to DB for this class
            db.prepare('DELETE FROM faculty_assignments WHERE class_id = ?').run(classId);
            for (const fa of autoFacultyAssignments) {
                db.prepare('INSERT INTO faculty_assignments (id, faculty_id, class_id, subject_id) VALUES (?, ?, ?, ?)').run(
                    uuid(), fa.faculty_id, classId, fa.subject_id
                );
            }

            classInfos.push({ classId, year: cls.year, sectionLabel, studentCount, requirements, facultyAssignments: autoFacultyAssignments, labDayCount: {} });
        }

        // Sort classes by most constrained first (MRV heuristic)
        classInfos.sort((a, b) => {
            const aRemaining = a.requirements.reduce((s, r) => s + r.remaining, 0);
            const bRemaining = b.requirements.reduce((s, r) => s + r.remaining, 0);
            return bRemaining - aRemaining;
        });

        const allAssignments: Assignment[] = [];

        // ═══════════════════════════════════════════
        // HELPER: Check ALL hard constraints for a faculty at a slot
        // ═══════════════════════════════════════════
        function isFacultyBlocked(facultyId: string, day: string, period: number): boolean {
            const sk = `${day}_${period}`;
            if (facultyUnavailable.get(facultyId)?.has(sk)) return true;   // H4: availability
            if (idx.isFacultyBusy(facultyId, sk)) return true;             // H1+R3+R6: double-booking across ALL timetables
            // R4: Faculty must get ≥1 empty period per day
            const dayLoad = idx.getFacultyDayLoad(facultyId, day);
            if (dayLoad >= periods_per_day - 1) return true;               // Would leave 0 free periods
            return false;
        }

        // ═══════════════════════════════════════════
        // HELPER: Find best room satisfying hard constraints
        // ═══════════════════════════════════════════
        function findRoom(sk: string, ci: ClassInfo, subjectType: string): string | undefined {
            // Prefer room consistency — same room this class used before
            const prevRoom = idx.getClassPrevRoom(ci.classId);
            if (prevRoom && !idx.isRoomBusy(prevRoom, sk)) {
                const info = roomInfo.get(prevRoom);
                if (info && info.capacity >= ci.studentCount && info.type === subjectType) {
                    return prevRoom;
                }
            }

            // Scan selected rooms
            for (const rid of selected_room_ids) {
                if (idx.isRoomBusy(rid, sk)) continue;              // H2: double-booking
                const info = roomInfo.get(rid);
                if (!info) continue;
                if (info.capacity < ci.studentCount) continue;       // H6: capacity
                if (info.type !== subjectType) continue;             // H5: type match
                return rid;
            }
            return undefined;
        }

        // ═══════════════════════════════════════════
        // HELPER: Find best lab satisfying hard constraints + type match
        // ═══════════════════════════════════════════
        function findLab(day: string, startP: number, period_count: number, req: SubjectReq): string | undefined {
            // Prefer labs matching the subject's lab_type_id
            const candidates = [...selected_lab_ids];
            // Sort: matching type first
            if (req.labTypeId) {
                candidates.sort((a, b) => {
                    const aMatch = labInfo.get(a)?.labTypeId === req.labTypeId ? 0 : 1;
                    const bMatch = labInfo.get(b)?.labTypeId === req.labTypeId ? 0 : 1;
                    return aMatch - bMatch;
                });
            }
            for (const lid of candidates) {
                let free = true;
                for (let o = 0; o < period_count; o++) {
                    if (idx.isLabBusy(lid, `${day}_${startP + o}`)) { free = false; break; }
                }
                if (free) return lid;
            }
            return undefined;
        }

        // ═══════════════════════════════════════════
        // HELPER: Score a theory/free slot (O(1) via index)
        // ═══════════════════════════════════════════
        function scoreSlot(ci: ClassInfo, subj: SubjectReq, day: string, period: number): number {
            let score = 0;

            // S1: Subject day spread
            const sameDayCount = idx.getClassDaySubjectCount(ci.classId, day, subj.id);
            if (sameDayCount === 0) score += W.SUBJECT_DAY_SPREAD;
            else score += W.SUBJECT_REPEAT_SAME_DAY * sameDayCount;

            // S3: Morning preference for theory
            if (subj.type === 'theory') {
                score += period <= 4 ? W.MORNING_THEORY : Math.floor(W.MORNING_THEORY * 0.25);
            }

            // S2: Anti-cluster (avoid same subject in adjacent periods)
            const prevSlot = idx.isClassSlotUsed(ci.classId, `${day}_${period - 1}`);
            if (prevSlot) {
                const prevSameSubj = idx.getClassDaySubjectCount(ci.classId, day, subj.id);
                if (prevSameSubj > 0) score -= W.ANTI_CLUSTER * 2;
            } else {
                score += W.ANTI_CLUSTER;
            }

            // S5: Even day load
            const dayLoad = idx.getClassDayLoad(ci.classId, day);
            score += W.EVEN_DAY_LOAD * Math.max(0, periods_per_day - dayLoad);

            // S7: Faculty load balance
            const faculty = ci.facultyAssignments.find(fa => fa.subject_id === subj.id);
            if (faculty) {
                const facultyDayLoad = idx.getFacultyDayLoad(faculty.faculty_id, day);
                score += W.FACULTY_LOAD_BALANCE * Math.max(0, 4 - facultyDayLoad);
            }

            // S4: Room consistency
            if (selected_room_ids.length > 0) {
                const prevRoom = idx.getClassPrevRoom(ci.classId);
                if (prevRoom && !idx.isRoomBusy(prevRoom, `${day}_${period}`)) {
                    score += W.ROOM_CONSISTENCY;
                }
            }

            return score;
        }

        // ═══════════════════════════════════════════
        // Valid lab start periods (must not span across breaks)
        // ═══════════════════════════════════════════
        const validLabStarts: number[] = [];
        for (let s = 1; s <= periods_per_day - lab_consecutive_periods + 1; s++) {
            let spansBreak = false;
            for (let o = 0; o < lab_consecutive_periods - 1; o++) {
                if (BREAK_AFTER_PERIOD.has(s + o)) { spansBreak = true; break; }
            }
            if (!spansBreak) validLabStarts.push(s);
        }

        // ═══════════════════════════════════════════
        // PHASE 1: LABS (most constrained first)
        // ═══════════════════════════════════════════
        const allLabReqs: { ci: ClassInfo; subj: SubjectReq }[] = [];
        for (const ci of classInfos) {
            for (const subj of ci.requirements.filter(r => r.type === 'lab' && r.remaining > 0)) {
                allLabReqs.push({ ci, subj });
            }
        }
        // MRV: most constrained labs first (highest hours)
        allLabReqs.sort((a, b) => b.subj.remaining - a.subj.remaining);

        for (const { ci, subj } of allLabReqs) {
            const neededBlocks = Math.ceil(subj.remaining / lab_consecutive_periods);
            const faculty = ci.facultyAssignments.find(fa => fa.subject_id === subj.id);

            for (let block = 0; block < neededBlocks; block++) {
                let bestOption: { day: string; startP: number; labId?: string; score: number } | null = null;

                for (const day of DAYS) {
                    for (const startP of validLabStarts) {
                        // Check class slots free
                        let classFree = true;
                        for (let o = 0; o < lab_consecutive_periods; o++) {
                            if (idx.isClassSlotUsed(ci.classId, `${day}_${startP + o}`)) { classFree = false; break; }
                        }
                        if (!classFree) continue;

                        // H4+H1+R3+R4: Faculty available for ALL consecutive periods
                        if (faculty) {
                            let facultyOk = true;
                            for (let o = 0; o < lab_consecutive_periods; o++) {
                                if (isFacultyBlocked(faculty.faculty_id, day, startP + o)) { facultyOk = false; break; }
                            }
                            if (!facultyOk) continue;
                        }

                        // H3: Find available lab
                        const labId = findLab(day, startP, lab_consecutive_periods, subj);
                        if (!labId && selected_lab_ids.length > 0) continue;

                        // Score this option
                        let score = 0;
                        const labsOnDay = ci.labDayCount[day] || 0;
                        score += 50 * (3 - labsOnDay);          // Spread labs across days
                        if (startP >= 5) score += 25;           // Prefer afternoon for labs
                        else if (startP >= 3) score += 12;
                        const dayLoad = idx.getClassDayLoad(ci.classId, day);
                        score += 8 * (periods_per_day - dayLoad);
                        // Penalty for too many labs on same day across all classes
                        if (faculty) {
                            const fLoad = idx.getFacultyDayLoad(faculty.faculty_id, day);
                            score -= fLoad * 6;
                        }

                        if (!bestOption || score > bestOption.score) {
                            bestOption = { day, startP, labId, score };
                        }
                    }
                }

                if (bestOption) {
                    for (let offset = 0; offset < lab_consecutive_periods; offset++) {
                        const p = bestOption.startP + offset;
                        const a: Assignment = {
                            class_id: ci.classId, day: bestOption.day, period: p,
                            subject_id: subj.id, subject_name: subj.name,
                        };
                        if (bestOption.labId) a.lab_id = bestOption.labId;
                        if (faculty) a.faculty_id = faculty.faculty_id;
                        allAssignments.push(a);
                        idx.addAssignment(a);
                    }
                    subj.remaining -= lab_consecutive_periods;
                    ci.labDayCount[bestOption.day] = (ci.labDayCount[bestOption.day] || 0) + 1;
                } else {
                    conflicts.push(`Cannot place lab "${subj.name}" block ${block + 1} for ${ci.sectionLabel}: no valid slots (faculty availability or lab conflicts)`);
                }
            }
        }

        // ═══════════════════════════════════════════
        // PHASE 2: THEORY (scored slot selection)
        // ═══════════════════════════════════════════
        for (const ci of classInfos) {
            // MRV within class: subjects with most remaining hours first
            const theoryReqs = ci.requirements.filter(r => r.type === 'theory' && r.remaining > 0);
            theoryReqs.sort((a, b) => b.remaining - a.remaining);

            for (const subj of theoryReqs) {
                while (subj.remaining > 0) {
                    let bestSlot: { day: string; period: number; roomId?: string; score: number } | null = null;

                    for (const day of DAYS) {
                        for (let p = 1; p <= periods_per_day; p++) {
                            const sk = `${day}_${p}`;
                            if (idx.isClassSlotUsed(ci.classId, sk)) continue;

                            // H1+H4+R3+R4+R6: Faculty hard check
                            const faculty = ci.facultyAssignments.find(fa => fa.subject_id === subj.id);
                            if (faculty && isFacultyBlocked(faculty.faculty_id, day, p)) continue;

                            // H2+H5+H6: Room
                            const roomId = findRoom(sk, ci, 'theory');
                            let score = scoreSlot(ci, subj, day, p);
                            score += roomId ? W.ROOM_AVAILABLE : W.NO_ROOM_PENALTY;

                            if (!bestSlot || score > bestSlot.score) {
                                bestSlot = { day, period: p, roomId, score };
                            }
                        }
                    }

                    if (bestSlot) {
                        const faculty = ci.facultyAssignments.find(fa => fa.subject_id === subj.id);
                        const a: Assignment = {
                            class_id: ci.classId, day: bestSlot.day, period: bestSlot.period,
                            subject_id: subj.id, subject_name: subj.name,
                        };
                        if (bestSlot.roomId) a.room_id = bestSlot.roomId;
                        if (faculty) a.faculty_id = faculty.faculty_id;
                        allAssignments.push(a);
                        idx.addAssignment(a);
                        subj.remaining--;
                    } else {
                        conflicts.push(`Cannot place "${subj.name}" for ${ci.sectionLabel} (${subj.remaining} remaining): all valid slots exhausted`);
                        break;
                    }
                }
            }
        }

        // ═══════════════════════════════════════════
        // PHASE 3: FREE PERIODS
        // ═══════════════════════════════════════════
        for (const ci of classInfos) {
            const freeReqs = ci.requirements.filter(r => r.isFree && r.remaining > 0);
            for (const fp of freeReqs) {
                while (fp.remaining > 0) {
                    let bestSlot: { day: string; period: number; score: number } | null = null;

                    for (const day of DAYS) {
                        for (let p = 1; p <= periods_per_day; p++) {
                            const sk = `${day}_${p}`;
                            if (idx.isClassSlotUsed(ci.classId, sk)) continue;
                            let score = 0;
                            const freeOnDay = idx.getClassDayFreeCount(ci.classId, day);
                            score += 30 * (2 - freeOnDay);
                            const sameFreeOnDay = idx.getClassDaySubjectCount(ci.classId, day, fp.id);
                            if (sameFreeOnDay === 0) score += 40; else score -= 50;
                            score += p * 3;  // Prefer later slots for free periods
                            if (!bestSlot || score > bestSlot.score) bestSlot = { day, period: p, score };
                        }
                    }

                    if (bestSlot) {
                        const a: Assignment = {
                            class_id: ci.classId, day: bestSlot.day, period: bestSlot.period,
                            subject_id: fp.id, subject_name: fp.name, is_free: true,
                        };
                        allAssignments.push(a);
                        idx.addAssignment(a);
                        fp.remaining--;
                    } else break;
                }
            }
        }

        // ═══════════════════════════════════════════
        // PHASE 4: FORCE-FILL (respects faculty constraints!)
        // ═══════════════════════════════════════════
        for (const ci of classInfos) {
            const unfinished = ci.requirements.filter(r => r.remaining > 0);
            for (const subj of unfinished) {
                while (subj.remaining > 0) {
                    let placed = false;
                    for (const day of DAYS) {
                        if (placed) break;
                        for (let p = 1; p <= periods_per_day; p++) {
                            const sk = `${day}_${p}`;
                            if (idx.isClassSlotUsed(ci.classId, sk)) continue;

                            // ★ FIX: Check faculty constraints even in force-fill
                            const faculty = ci.facultyAssignments.find(fa => fa.subject_id === subj.id);
                            if (faculty && isFacultyBlocked(faculty.faculty_id, day, p)) continue;

                            const a: Assignment = {
                                class_id: ci.classId, day, period: p,
                                subject_id: subj.id, subject_name: subj.name,
                            };
                            if (subj.isFree) a.is_free = true;

                            // Try to find a room (don't block placement if unavailable)
                            if (!subj.isFree) {
                                const roomId = findRoom(sk, ci, subj.type === 'lab' ? 'lab' : 'theory');
                                if (roomId) a.room_id = roomId;
                            }

                            if (faculty) a.faculty_id = faculty.faculty_id;
                            allAssignments.push(a);
                            idx.addAssignment(a);
                            subj.remaining--;
                            placed = true;
                            break;
                        }
                    }
                    if (!placed) {
                        conflicts.push(`Exhausted all slots for "${subj.name}" in ${ci.sectionLabel} (${subj.remaining} remaining)`);
                        break;
                    }
                }
            }
        }

        // ═══════════════════════════════════════════
        // PHASE 5: SIMULATED ANNEALING (swap to improve quality)
        // ═══════════════════════════════════════════
        const MAX_ITERATIONS = 500;
        let improvements = 0;
        let temperature = 1.0;
        const coolingRate = 0.995;

        for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
            temperature *= coolingRate;
            let anyImproved = false;

            for (const ci of classInfos) {
                // Only swap theory assignments (labs are position-sensitive)
                const swappable = allAssignments.filter(a =>
                    a.class_id === ci.classId && !a.lab_id && !a.is_free
                );
                if (swappable.length < 2) continue;

                const i = Math.floor(Math.random() * swappable.length);
                let j = Math.floor(Math.random() * (swappable.length - 1));
                if (j >= i) j++;

                const a1 = swappable[i];
                const a2 = swappable[j];
                if (a1.subject_id === a2.subject_id && a1.day === a2.day) continue; // pointless swap

                const f1 = ci.facultyAssignments.find(fa => fa.subject_id === a1.subject_id);
                const f2 = ci.facultyAssignments.find(fa => fa.subject_id === a2.subject_id);
                const sk1 = `${a1.day}_${a1.period}`;
                const sk2 = `${a2.day}_${a2.period}`;

                // ★ FIX: Verify ALL hard constraints before swap
                // Check faculty at new positions
                if (f1 && f1.faculty_id !== f2?.faculty_id) {
                    // f1 would move to a2's slot — check if f1 is blocked there
                    if (isFacultyBlocked(f1.faculty_id, a2.day, a2.period)) continue;
                }
                if (f2 && f2.faculty_id !== f1?.faculty_id) {
                    if (isFacultyBlocked(f2.faculty_id, a1.day, a1.period)) continue;
                }

                // Check rooms: can the swapped rooms fit?
                if (a1.room_id && a2.room_id) {
                    // Both have rooms — they just swap, no capacity issue since same class
                } else if (a1.room_id && !a2.room_id) {
                    // a1's room at sk2 must be free (except a1 is vacating sk1)
                    if (idx.isRoomBusy(a1.room_id, sk2)) continue;
                } else if (!a1.room_id && a2.room_id) {
                    if (idx.isRoomBusy(a2.room_id, sk1)) continue;
                }

                // Score comparison
                const s1: SubjectReq = { id: a1.subject_id, name: a1.subject_name, type: 'theory', remaining: 0 };
                const s2: SubjectReq = { id: a2.subject_id, name: a2.subject_name, type: 'theory', remaining: 0 };

                const scoreBefore = scoreSlot(ci, s1, a1.day, a1.period) + scoreSlot(ci, s2, a2.day, a2.period);
                const scoreAfter = scoreSlot(ci, s1, a2.day, a2.period) + scoreSlot(ci, s2, a1.day, a1.period);
                const delta = scoreAfter - scoreBefore;

                // Accept if better, or with probability based on temperature (simulated annealing)
                if (delta > 0 || (temperature > 0.1 && Math.random() < Math.exp(delta / (temperature * 50)))) {
                    // ★ FIX: Properly update ALL index state during swap
                    idx.removeAssignment(a1);
                    idx.removeAssignment(a2);

                    const tmpDay = a1.day; const tmpPeriod = a1.period; const tmpRoom = a1.room_id;
                    a1.day = a2.day; a1.period = a2.period; a1.room_id = a2.room_id;
                    a2.day = tmpDay; a2.period = tmpPeriod; a2.room_id = tmpRoom;

                    idx.addAssignment(a1);
                    idx.addAssignment(a2);

                    if (delta > 0) improvements++;
                    anyImproved = true;
                }
            }
            if (!anyImproved && iter > 100 && temperature < 0.3) break;
        }

        // ═══════════════════════════════════════════
        // POST-GENERATION: Verify zero hard constraint violations
        // ═══════════════════════════════════════════
        const hardViolations: string[] = [];

        // Build check maps
        const facultyCheck = new Map<string, { day: string; period: number; classId: string }[]>();
        const roomCheck = new Map<string, { day: string; period: number; classId: string }[]>();
        const labCheck = new Map<string, { day: string; period: number; classId: string }[]>();

        for (const a of allAssignments) {
            if (a.faculty_id) {
                if (!facultyCheck.has(a.faculty_id)) facultyCheck.set(a.faculty_id, []);
                facultyCheck.get(a.faculty_id)!.push({ day: a.day, period: a.period, classId: a.class_id });
            }
            if (a.room_id) {
                if (!roomCheck.has(a.room_id)) roomCheck.set(a.room_id, []);
                roomCheck.get(a.room_id)!.push({ day: a.day, period: a.period, classId: a.class_id });
            }
            if (a.lab_id) {
                if (!labCheck.has(a.lab_id)) labCheck.set(a.lab_id, []);
                labCheck.get(a.lab_id)!.push({ day: a.day, period: a.period, classId: a.class_id });
            }
        }

        // H1: Faculty double-booking
        for (const [fId, slots] of facultyCheck) {
            const seen = new Set<string>();
            for (const s of slots) {
                const sk = `${s.day}_${s.period}`;
                if (seen.has(sk)) {
                    const fName = classInfos.flatMap(c => c.facultyAssignments).find(fa => fa.faculty_id === fId)?.faculty_name || fId;
                    hardViolations.push(`H1 VIOLATION: Faculty "${fName}" double-booked on ${s.day} P${s.period}`);
                }
                seen.add(sk);
            }
        }

        // H2: Room double-booking
        for (const [rId, slots] of roomCheck) {
            const seen = new Set<string>();
            for (const s of slots) {
                const sk = `${s.day}_${s.period}`;
                if (seen.has(sk)) {
                    hardViolations.push(`H2 VIOLATION: Room double-booked on ${s.day} P${s.period}`);
                }
                seen.add(sk);
            }
        }

        // H3: Lab double-booking
        for (const [lId, slots] of labCheck) {
            const seen = new Set<string>();
            for (const s of slots) {
                const sk = `${s.day}_${s.period}`;
                if (seen.has(sk)) {
                    hardViolations.push(`H3 VIOLATION: Lab double-booked on ${s.day} P${s.period}`);
                }
                seen.add(sk);
            }
        }

        // H4: Faculty availability
        for (const a of allAssignments) {
            if (a.faculty_id) {
                const sk = `${a.day}_${a.period}`;
                if (facultyUnavailable.get(a.faculty_id)?.has(sk)) {
                    hardViolations.push(`H4 VIOLATION: Faculty scheduled when unavailable on ${a.day} P${a.period}`);
                }
            }
        }

        if (hardViolations.length > 0) {
            conflicts.push(...hardViolations);
        }

        // ═══════════════════════════════════════════
        // COMPUTE SOFT CONSTRAINT SCORES
        // ═══════════════════════════════════════════
        const softScores = {
            consecutive_violations: 0,
            distribution_score: 0,
            back_to_back_labs: 0,
            room_switches: 0,
            total_score: 0,
        };

        for (const ci of classInfos) {
            const myAssignments = allAssignments.filter(a => a.class_id === ci.classId);

            for (const day of DAYS) {
                const daySlots = myAssignments.filter(a => a.day === day).sort((a, b) => a.period - b.period);

                // S2: Consecutive faculty periods
                const facultyPeriods = new Map<string, number[]>();
                for (const s of daySlots) {
                    if (s.faculty_id) {
                        if (!facultyPeriods.has(s.faculty_id)) facultyPeriods.set(s.faculty_id, []);
                        facultyPeriods.get(s.faculty_id)!.push(s.period);
                    }
                }
                for (const periods of facultyPeriods.values()) {
                    periods.sort((a, b) => a - b);
                    let consecutive = 1;
                    for (let i = 1; i < periods.length; i++) {
                        if (periods[i] === periods[i - 1] + 1) {
                            consecutive++;
                            if (consecutive > max_consecutive_theory) softScores.consecutive_violations++;
                        } else {
                            consecutive = 1;
                        }
                    }
                }

                // S6: Back-to-back different labs
                const labSlots = daySlots.filter(s => s.lab_id);
                for (let i = 1; i < labSlots.length; i++) {
                    if (labSlots[i].period === labSlots[i - 1].period + 1 && labSlots[i].subject_id !== labSlots[i - 1].subject_id) {
                        softScores.back_to_back_labs++;
                    }
                }
            }

            // S1+S5: Subject distribution
            const subjectDays = new Map<string, Set<string>>();
            for (const a of myAssignments) {
                if (!a.is_free) {
                    if (!subjectDays.has(a.subject_id)) subjectDays.set(a.subject_id, new Set());
                    subjectDays.get(a.subject_id)!.add(a.day);
                }
            }
            for (const days of subjectDays.values()) {
                softScores.distribution_score += days.size;
            }

            // S4: Room switches per day
            for (const day of DAYS) {
                const roomsUsed = new Set<string>();
                for (const a of myAssignments) {
                    if (a.day === day && a.room_id) roomsUsed.add(a.room_id);
                }
                if (roomsUsed.size > 1) softScores.room_switches += roomsUsed.size - 1;
            }
        }

        softScores.total_score =
            softScores.distribution_score * 10
            - softScores.consecutive_violations * 15
            - softScores.back_to_back_labs * 10
            - softScores.room_switches * 5;

        // ═══════════════════════════════════════════
        // SAVE TO DATABASE
        // ═══════════════════════════════════════════
        if (allAssignments.length > 0) {
            const insertTT = db.prepare('INSERT INTO timetables (id, class_id, day, period, subject_id, room_id, lab_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
            const insertFS = db.prepare('INSERT INTO faculty_schedule (id, faculty_id, day, period, class_id, subject_id) VALUES (?, ?, ?, ?, ?, ?)');
            const insertRS = db.prepare('INSERT INTO room_schedule (id, room_id, day, period, class_id) VALUES (?, ?, ?, ?, ?)');
            const insertLS = db.prepare('INSERT INTO lab_schedule (id, lab_id, day, period, class_id) VALUES (?, ?, ?, ?, ?)');

            db.transaction(() => {
                for (const cid of class_ids) {
                    db.prepare('DELETE FROM timetables WHERE class_id = ?').run(cid);
                    db.prepare('DELETE FROM faculty_schedule WHERE class_id = ?').run(cid);
                    db.prepare('DELETE FROM room_schedule WHERE class_id = ?').run(cid);
                    db.prepare('DELETE FROM lab_schedule WHERE class_id = ?').run(cid);
                }
                for (const a of allAssignments) {
                    insertTT.run(uuid(), a.class_id, a.day, a.period, a.subject_id, a.room_id || null, a.lab_id || null);
                    if (a.faculty_id) insertFS.run(uuid(), a.faculty_id, a.day, a.period, a.class_id, a.subject_id);
                    if (a.room_id) insertRS.run(uuid(), a.room_id, a.day, a.period, a.class_id);
                    if (a.lab_id) insertLS.run(uuid(), a.lab_id, a.day, a.period, a.class_id);
                }
            })();
        }

        const executionTime = Math.round(performance.now() - startTime);

        // ═══════════════════════════════════════════
        // LOG GENERATION
        // ═══════════════════════════════════════════
        const logStatus = allAssignments.length === 0 ? 'empty' : conflicts.length > 0 || hardViolations.length > 0 ? 'partial' : 'success';
        db.prepare("INSERT INTO generation_logs (id, execution_time_ms, class_ids_json, status, total_slots, conflict_count, soft_score_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(uuid(), executionTime, JSON.stringify(class_ids), logStatus, allAssignments.length, conflicts.length, JSON.stringify(softScores));

        releaseLock(db);

        // Build actionable suggestions from conflicts
        const suggestions: string[] = [];
        for (const c of conflicts) {
            if (c.includes('No faculty available')) suggestions.push(`💡 ${c} — add faculty interests or register more faculty`);
            else if (c.includes('Cannot place lab')) suggestions.push(`💡 ${c} — try adding more labs or reduce lab hours`);
            else if (c.includes('Cannot place')) suggestions.push(`💡 ${c} — reduce hours_per_week or add more time slots`);
            else if (c.includes('periods needed')) suggestions.push(`💡 ${c} — reduce subject hours or increase periods_per_day`);
            else suggestions.push(`⚠ ${c}`);
        }
        for (const hv of hardViolations) {
            suggestions.push(`⚠ Post-check: ${hv}`);
        }

        return NextResponse.json({
            success: allAssignments.length > 0,
            message: allAssignments.length > 0
                ? `Generated ${allAssignments.length} slots for ${class_ids.length} class(es)${suggestions.length > 0 ? ` with ${suggestions.length} suggestion(s)` : ''}`
                : 'No slots could be generated — check suggestions below',
            total_slots: allAssignments.length,
            period_times: PERIOD_TIMES,
            algorithm: 'CSP + MRV heuristic + Simulated Annealing + Faculty Interest FCFS (v3.0)',
            optimizations: improvements,
            execution_time_ms: executionTime,
            soft_scores: softScores,
            suggestions: suggestions.length > 0 ? suggestions : undefined,
            hard_violations: hardViolations.length > 0 ? hardViolations : undefined,
            conflicts: conflicts.length > 0 ? conflicts : undefined,
        });
    } catch (error) {
        const executionTime = Math.round(performance.now() - startTime);
        try {
            db.prepare("INSERT INTO generation_logs (id, execution_time_ms, class_ids_json, status, error_message) VALUES (?, ?, ?, 'failed', ?)")
                .run(uuid(), executionTime, '[]', (error as Error).message);
        } catch { /* ignore logging error */ }
        releaseLock(db);
        console.error('Generation error:', error);
        return NextResponse.json({ error: 'Generation failed: ' + (error as Error).message }, { status: 500 });
    }
}
