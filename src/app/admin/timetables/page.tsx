'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, BookOpen, ChevronDown, Info, Beaker, Coffee, BookMarked } from 'lucide-react';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const SCHEDULE = [
    { type: 'period' as const, period: 1, time: '9:00 - 9:50' },
    { type: 'period' as const, period: 2, time: '9:50 - 10:40' },
    { type: 'break' as const, label: 'Short Break', time: '10:40 - 11:00', icon: '☕' },
    { type: 'period' as const, period: 3, time: '11:00 - 11:50' },
    { type: 'period' as const, period: 4, time: '11:50 - 12:40' },
    { type: 'break' as const, label: 'Lunch Break', time: '12:40 - 1:50', icon: '🍽️' },
    { type: 'period' as const, period: 5, time: '1:50 - 2:40' },
    { type: 'period' as const, period: 6, time: '2:40 - 3:30' },
    { type: 'period' as const, period: 7, time: '3:30 - 4:20' },
];

interface ClassItem { id: string; year: number; section_name: string; }
interface TTEntry { day: string; period: number; subject_name?: string; subject_type?: string; room_name?: string; lab_name?: string; faculty_name?: string; }

const CELL_COLORS = {
    theory: { bg: 'rgba(99,102,241,0.08)', border: 'rgba(99,102,241,0.2)', text: '#a5b4fc', badge: '#6366f1' },
    lab: { bg: 'rgba(34,197,94,0.08)', border: 'rgba(34,197,94,0.2)', text: '#86efac', badge: '#22c55e' },
    free: { bg: 'rgba(251,191,36,0.06)', border: 'rgba(251,191,36,0.15)', text: '#fde68a', badge: '#f59e0b' },
    empty: { bg: 'transparent', border: 'rgba(99,102,241,0.04)', text: '#1e293b', badge: 'transparent' },
};

export default function TimetablesViewerPage() {
    const [classes, setClasses] = useState<ClassItem[]>([]);
    const [timetable, setTimetable] = useState<TTEntry[]>([]);
    const [selectedClass, setSelectedClass] = useState('');
    const [loadingTT, setLoadingTT] = useState(false);

    useEffect(() => { fetch('/api/data?table=classes').then(r => r.json()).then(d => setClasses(Array.isArray(d) ? d : [])); }, []);

    const loadTT = async (classId: string) => {
        setSelectedClass(classId); setLoadingTT(true);
        const res = await fetch(`/api/data?table=timetable&class_id=${classId}`);
        setTimetable(await res.json()); setLoadingTT(false);
    };

    const getCell = (day: string, period: number) => timetable.find(e => e.day === day && e.period === period);
    const selectedClassInfo = classes.find(c => c.id === selectedClass);
    const handlePrint = () => window.print();

    const getCellType = (cell?: TTEntry): keyof typeof CELL_COLORS => {
        if (!cell) return 'empty';
        if (cell.lab_name || cell.subject_type === 'lab') return 'lab';
        if (cell.subject_type === 'free') return 'free';
        return 'theory';
    };

    // Stats
    const theoryCount = timetable.filter(e => e.subject_type === 'theory').length;
    const labCount = timetable.filter(e => e.lab_name || e.subject_type === 'lab').length;
    const freeCount = timetable.filter(e => e.subject_type === 'free').length;

    return (
        <div>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
                <div>
                    <h1 style={{ fontSize: 26, fontWeight: 700, color: '#f1f5f9', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 10 }}>
                        <BookOpen size={24} color="#6366f1" />
                        Generated Timetables
                    </h1>
                    <p style={{ color: '#64748b', fontSize: 14 }}>View, analyze and export class timetables</p>
                </div>
            </div>

            {/* Class Selector */}
            <div style={{
                padding: '16px 20px', borderRadius: 16, marginBottom: 20,
                background: 'rgba(15,23,42,0.4)', border: '1px solid rgba(99,102,241,0.08)',
            }}>
                <p style={{ fontSize: 12, color: '#64748b', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>Select Class</p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {classes.map(c => {
                        const active = selectedClass === c.id;
                        return (
                            <motion.button
                                key={c.id}
                                whileHover={{ scale: 1.02 }}
                                whileTap={{ scale: 0.98 }}
                                onClick={() => loadTT(c.id)}
                                style={{
                                    padding: '10px 20px', borderRadius: 12, fontSize: 13, cursor: 'pointer', fontWeight: 500,
                                    border: `1px solid ${active ? 'rgba(99,102,241,0.5)' : 'rgba(99,102,241,0.12)'}`,
                                    background: active ? 'linear-gradient(135deg, rgba(99,102,241,0.15), rgba(99,102,241,0.08))' : 'rgba(15,23,42,0.3)',
                                    color: active ? '#a5b4fc' : '#94a3b8',
                                    boxShadow: active ? '0 0 20px rgba(99,102,241,0.1)' : 'none',
                                    transition: 'all 0.2s ease',
                                }}
                            >
                                Year {c.year} - {c.section_name}
                            </motion.button>
                        );
                    })}
                    {classes.length === 0 && <p style={{ color: '#475569', fontSize: 13 }}>No timetables generated yet. Generate one from the Timetable Generator.</p>}
                </div>
            </div>

            {/* Timetable Content */}
            <AnimatePresence mode="wait">
                {selectedClass && (
                    <motion.div key={selectedClass} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
                        {/* Section Header + Stats + Print */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                            <div>
                                {selectedClassInfo && (
                                    <h2 style={{ fontSize: 18, fontWeight: 600, color: '#f1f5f9' }}>
                                        Year {selectedClassInfo.year} — Section {selectedClassInfo.section_name}
                                    </h2>
                                )}
                            </div>
                            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                {timetable.length > 0 && (
                                    <div style={{ display: 'flex', gap: 12, marginRight: 8 }}>
                                        <span style={{ fontSize: 11, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 4 }}>
                                            <span style={{ width: 8, height: 8, borderRadius: 2, background: CELL_COLORS.theory.badge, display: 'inline-block' }} />
                                            Theory ({theoryCount})
                                        </span>
                                        <span style={{ fontSize: 11, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 4 }}>
                                            <span style={{ width: 8, height: 8, borderRadius: 2, background: CELL_COLORS.lab.badge, display: 'inline-block' }} />
                                            Lab ({labCount})
                                        </span>
                                        <span style={{ fontSize: 11, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 4 }}>
                                            <span style={{ width: 8, height: 8, borderRadius: 2, background: CELL_COLORS.free.badge, display: 'inline-block' }} />
                                            Activity ({freeCount})
                                        </span>
                                    </div>
                                )}
                                <button onClick={handlePrint} className="btn-primary" style={{ padding: '8px 16px', fontSize: 13 }}>
                                    <span style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: 6 }}><Download size={14} />Export</span>
                                </button>
                            </div>
                        </div>

                        {/* Timetable Table */}
                        {loadingTT ? (
                            <div style={{ textAlign: 'center', padding: 60 }}><div className="spinner" style={{ width: 32, height: 32, margin: '0 auto' }} /></div>
                        ) : timetable.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: 60, borderRadius: 16, background: 'rgba(15,23,42,0.3)', border: '1px solid rgba(99,102,241,0.08)' }}>
                                <Info size={32} color="#475569" style={{ marginBottom: 12 }} />
                                <p style={{ color: '#475569', fontSize: 14 }}>No timetable data for this class</p>
                            </div>
                        ) : (
                            <div style={{
                                borderRadius: 18, overflow: 'hidden',
                                background: 'rgba(15,23,42,0.4)', border: '1px solid rgba(99,102,241,0.1)',
                                boxShadow: '0 4px 30px rgba(0,0,0,0.2)',
                            }} id="tt-print">
                                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 800 }}>
                                    <thead>
                                        <tr style={{ background: 'rgba(99,102,241,0.06)' }}>
                                            <th style={{ padding: '14px 12px', fontSize: 11, color: '#64748b', textAlign: 'left', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', width: 90, borderBottom: '1px solid rgba(99,102,241,0.08)' }}>
                                                Time
                                            </th>
                                            {DAYS.map((d, i) => (
                                                <th key={d} style={{ padding: '14px 8px', fontSize: 12, color: '#94a3b8', textAlign: 'center', fontWeight: 600, borderBottom: '1px solid rgba(99,102,241,0.08)' }}>
                                                    <span style={{ display: 'block', fontSize: 12 }}>{d}</span>
                                                    <span style={{ display: 'block', fontSize: 10, color: '#475569', marginTop: 2 }}>{DAY_SHORT[i]}</span>
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {SCHEDULE.map((row, idx) => {
                                            if (row.type === 'break') {
                                                return (
                                                    <tr key={`break-${idx}`}>
                                                        <td colSpan={7} style={{
                                                            padding: '8px 16px', textAlign: 'center', fontSize: 12, fontWeight: 600,
                                                            color: '#fbbf24',
                                                            background: 'linear-gradient(90deg, rgba(251,191,36,0.03), rgba(251,191,36,0.06), rgba(251,191,36,0.03))',
                                                            borderTop: '1px dashed rgba(251,191,36,0.15)',
                                                            borderBottom: '1px dashed rgba(251,191,36,0.15)',
                                                        }}>
                                                            {row.icon} {row.label} <span style={{ color: '#92400e', fontWeight: 400 }}>({row.time})</span>
                                                        </td>
                                                    </tr>
                                                );
                                            }

                                            const p = row.period!;
                                            return (
                                                <tr key={p} style={{ borderBottom: '1px solid rgba(99,102,241,0.04)' }}>
                                                    <td style={{
                                                        padding: '8px 12px', fontSize: 11, fontWeight: 500, verticalAlign: 'middle',
                                                        background: 'rgba(99,102,241,0.03)',
                                                    }}>
                                                        <div style={{ color: '#94a3b8', fontWeight: 600 }}>P{p}</div>
                                                        <div style={{ fontSize: 10, color: '#475569', marginTop: 1 }}>{row.time}</div>
                                                    </td>
                                                    {DAYS.map(d => {
                                                        const cell = getCell(d, p);
                                                        const type = getCellType(cell);
                                                        const colors = CELL_COLORS[type];
                                                        return (
                                                            <td key={d} style={{ padding: '4px 3px', textAlign: 'center', verticalAlign: 'top' }}>
                                                                {cell ? (
                                                                    <motion.div
                                                                        initial={{ opacity: 0, scale: 0.9 }}
                                                                        animate={{ opacity: 1, scale: 1 }}
                                                                        transition={{ delay: idx * 0.02 }}
                                                                        style={{
                                                                            padding: '7px 5px', borderRadius: 8, minHeight: 42,
                                                                            background: colors.bg, border: `1px solid ${colors.border}`,
                                                                            cursor: 'default', transition: 'all 0.2s ease',
                                                                        }}
                                                                        onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.03)'; e.currentTarget.style.boxShadow = `0 4px 15px ${colors.border}`; }}
                                                                        onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = 'none'; }}
                                                                    >
                                                                        <p style={{ fontSize: 11, fontWeight: 600, color: colors.text, lineHeight: 1.3 }}>
                                                                            {cell.subject_name || 'Activity'}
                                                                        </p>
                                                                        {(cell.room_name || cell.lab_name) && (
                                                                            <p style={{ fontSize: 9, color: '#64748b', marginTop: 2 }}>
                                                                                {cell.lab_name ? `🔬 ${cell.lab_name}` : `📍 ${cell.room_name}`}
                                                                            </p>
                                                                        )}
                                                                        {cell.faculty_name && (
                                                                            <p style={{ fontSize: 9, color: '#475569', marginTop: 1 }}>
                                                                                👤 {cell.faculty_name}
                                                                            </p>
                                                                        )}
                                                                    </motion.div>
                                                                ) : (
                                                                    <div style={{ minHeight: 42, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                                        <span style={{ color: '#1e293b', fontSize: 14 }}>·</span>
                                                                    </div>
                                                                )}
                                                            </td>
                                                        );
                                                    })}
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
