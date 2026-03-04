'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';
import { Calendar, BookOpen, Heart, MessageCircle, User, Send, ChevronLeft, Clock, GraduationCap, Users, LogOut, Save, Grid3X3 } from 'lucide-react';

interface Profile { id: string; name: string; email: string; department?: string; }
interface ScheduleEntry { day: string; period: number; subject_name: string; year: number; section_name: string; }
interface ClassInfo { id: string; year: number; section_name: string; students: { id: string; name: string; reg_no: string; email: string }[]; }
interface Subject { id: string; name: string; type: string; }
interface ConvoItem { id: string; other_name: string; other_id: string; last_message?: string; unread: boolean; }
interface MsgItem { id: string; content: string; sender_id: string; sender_name: string; created_at: string; }

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

export default function FacultyDashboard() {
    const router = useRouter();
    const [activeTab, setActiveTab] = useState('schedule');
    const [profile, setProfile] = useState<Profile | null>(null);
    const [schedule, setSchedule] = useState<ScheduleEntry[]>([]);
    const [myClasses, setMyClasses] = useState<ClassInfo[]>([]);
    const [subjects, setSubjects] = useState<Subject[]>([]);
    const [interests, setInterests] = useState<string[]>([]);
    const [convos, setConvos] = useState<ConvoItem[]>([]);
    const [messages, setMessages] = useState<MsgItem[]>([]);
    const [activeConvo, setActiveConvo] = useState<ConvoItem | null>(null);
    const [msgInput, setMsgInput] = useState('');
    const [loading, setLoading] = useState(true);

    // Availability state
    const [availability, setAvailability] = useState<Record<string, Record<number, boolean>>>({});
    const [savingAvail, setSavingAvail] = useState(false);

    useEffect(() => {
        async function load() {
            const [pR, sR, cR, subR, iR, cvR, avR] = await Promise.all([
                fetch('/api/data?table=profile'), fetch('/api/data?table=my-schedule'), fetch('/api/data?table=my-classes'),
                fetch('/api/data?table=subjects'), fetch('/api/data?table=my-interests'), fetch('/api/data?table=conversations'),
                fetch('/api/faculty/availability'),
            ]);
            setProfile(await pR.json()); setSchedule(await sR.json()); setMyClasses(await cR.json());
            setSubjects(await subR.json());
            const ints = await iR.json();
            setInterests(Array.isArray(ints) ? ints.map((i: { subject_id: string }) => i.subject_id) : []);
            setConvos(await cvR.json());
            const avData = await avR.json();
            setAvailability(avData.matrix || {});
            setLoading(false);
        }
        load();
    }, []);

    const getCell = (day: string, period: number) => schedule.find(s => s.day === day && s.period === period);
    const toggleInterest = (id: string) => setInterests(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
    const saveInterests = async () => {
        await fetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save-interests', subject_ids: interests }) });
        toast.success('Interests saved!');
    };

    const toggleAvailability = (day: string, period: number) => {
        setAvailability(prev => {
            const updated = { ...prev };
            if (!updated[day]) updated[day] = {};
            updated[day] = { ...updated[day], [period]: !updated[day][period] };
            return updated;
        });
    };

    const saveAvailability = async () => {
        setSavingAvail(true);
        try {
            await fetch('/api/faculty/availability', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ matrix: availability }),
            });
            toast.success('Availability saved!');
        } catch { toast.error('Failed to save'); }
        setSavingAvail(false);
    };

    const openConvo = async (convo: ConvoItem) => { setActiveConvo(convo); const res = await fetch(`/api/data?table=messages&conversation_id=${convo.id}`); setMessages(await res.json()); };
    const sendMessage = async () => {
        if (!msgInput.trim() || !activeConvo) return;
        await fetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'send-message', conversation_id: activeConvo.id, content: msgInput.trim() }) });
        setMsgInput(''); const res = await fetch(`/api/data?table=messages&conversation_id=${activeConvo.id}`); setMessages(await res.json());
    };
    const handleLogout = async () => { try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { } router.push('/select-role'); };

    const tabs = [
        { id: 'schedule', label: 'Schedule', icon: Calendar },
        { id: 'availability', label: 'Availability', icon: Grid3X3 },
        { id: 'classes', label: 'My Classes', icon: BookOpen },
        { id: 'interests', label: 'Interests', icon: Heart },
        { id: 'messages', label: 'Messages', icon: MessageCircle },
        { id: 'profile', label: 'Profile', icon: User },
    ];

    if (loading) return <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', background: '#030712' }}><div className="spinner" style={{ width: 40, height: 40 }} /></div>;

    const totalClasses = schedule.length;
    const totalStudents = myClasses.reduce((s, c) => s + c.students.length, 0);

    return (
        <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg, #030712 0%, #0f172a 50%, #1e1b4b 100%)' }}>
            <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 20px' }}>
                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
                    <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#64748b', fontSize: 12, marginBottom: 4 }}>
                            <Clock size={12} />
                            <span>{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</span>
                        </div>
                        <h1 style={{ fontSize: 24, fontWeight: 700, color: '#f1f5f9' }}>Welcome back, {profile?.name} 👋</h1>
                        <p style={{ color: '#64748b', fontSize: 13, marginTop: 2 }}>Faculty · {profile?.department}</p>
                    </div>
                    <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} onClick={handleLogout}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 10, border: '1px solid rgba(239,68,68,0.2)', background: 'rgba(239,68,68,0.06)', color: '#f87171', fontSize: 13, cursor: 'pointer' }}>
                        <LogOut size={14} />Logout
                    </motion.button>
                </div>

                {/* Quick Stats */}
                <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
                    {[
                        { label: 'Classes/Week', value: totalClasses, icon: Calendar, color: '#6366f1' },
                        { label: 'Sections', value: myClasses.length, icon: BookOpen, color: '#22c55e' },
                        { label: 'Students', value: totalStudents, icon: Users, color: '#8b5cf6' },
                        { label: 'Interests', value: interests.length, icon: Heart, color: '#f43f5e' },
                    ].map((stat, i) => (
                        <motion.div key={stat.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
                            style={{ flex: 1, padding: '14px 16px', borderRadius: 14, background: `linear-gradient(135deg, ${stat.color}08, ${stat.color}03)`, border: `1px solid ${stat.color}12` }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <stat.icon size={16} color={stat.color} />
                                <div><p style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.3px' }}>{stat.label}</p><p style={{ fontSize: 20, fontWeight: 700, color: '#f1f5f9' }}>{stat.value}</p></div>
                            </div>
                        </motion.div>
                    ))}
                </div>

                {/* Tabs */}
                <div style={{ display: 'flex', gap: 4, marginBottom: 24, padding: 4, borderRadius: 14, background: 'rgba(15,23,42,0.4)', border: '1px solid rgba(99,102,241,0.06)', width: 'fit-content', flexWrap: 'wrap' }}>
                    {tabs.map(tab => (
                        <button key={tab.id} onClick={() => { setActiveTab(tab.id); if (tab.id !== 'messages') setActiveConvo(null); }} style={{
                            display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px', borderRadius: 10, border: 'none',
                            background: activeTab === tab.id ? 'linear-gradient(135deg, rgba(99,102,241,0.15), rgba(99,102,241,0.08))' : 'transparent',
                            color: activeTab === tab.id ? '#a5b4fc' : '#64748b', fontWeight: activeTab === tab.id ? 600 : 400, fontSize: 13, cursor: 'pointer', transition: 'all 0.2s ease',
                        }}><tab.icon size={15} />{tab.label}
                            {tab.id === 'messages' && convos.some(c => c.unread) && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#6366f1' }} />}
                        </button>
                    ))}
                </div>

                <AnimatePresence mode="wait">
                    {/* Schedule Tab */}
                    {activeTab === 'schedule' && (
                        <motion.div key="sch" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                            {schedule.length === 0 ? (
                                <div style={{ textAlign: 'center', padding: 60, borderRadius: 16, background: 'rgba(15,23,42,0.3)', border: '1px solid rgba(99,102,241,0.08)' }}>
                                    <Calendar size={32} color="#475569" style={{ marginBottom: 12 }} />
                                    <p style={{ color: '#475569', fontSize: 14 }}>No schedule assigned yet</p>
                                </div>
                            ) : (
                                <div style={{ borderRadius: 18, overflow: 'auto', background: 'rgba(15,23,42,0.4)', border: '1px solid rgba(99,102,241,0.1)', boxShadow: '0 4px 30px rgba(0,0,0,0.2)' }}>
                                    <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 800 }}>
                                        <thead>
                                            <tr style={{ background: 'rgba(99,102,241,0.06)' }}>
                                                <th style={{ padding: '14px 12px', fontSize: 11, color: '#64748b', textAlign: 'left', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', width: 90, borderBottom: '1px solid rgba(99,102,241,0.08)' }}>Time</th>
                                                {DAYS.map((d, i) => (
                                                    <th key={d} style={{ padding: '14px 8px', fontSize: 12, color: '#94a3b8', textAlign: 'center', fontWeight: 600, borderBottom: '1px solid rgba(99,102,241,0.08)' }}>
                                                        <span style={{ display: 'block' }}>{d}</span>
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
                                                            <td colSpan={7} style={{ padding: '8px 16px', textAlign: 'center', fontSize: 12, fontWeight: 600, color: '#fbbf24', background: 'linear-gradient(90deg, rgba(251,191,36,0.03), rgba(251,191,36,0.06), rgba(251,191,36,0.03))', borderTop: '1px dashed rgba(251,191,36,0.15)', borderBottom: '1px dashed rgba(251,191,36,0.15)' }}>
                                                                {row.icon} {row.label} <span style={{ color: '#92400e', fontWeight: 400 }}>({row.time})</span>
                                                            </td>
                                                        </tr>
                                                    );
                                                }
                                                const p = row.period!;
                                                return (
                                                    <tr key={p} style={{ borderBottom: '1px solid rgba(99,102,241,0.04)' }}>
                                                        <td style={{ padding: '8px 12px', fontSize: 11, fontWeight: 500, background: 'rgba(99,102,241,0.03)' }}>
                                                            <div style={{ color: '#94a3b8', fontWeight: 600 }}>P{p}</div>
                                                            <div style={{ fontSize: 10, color: '#475569', marginTop: 1 }}>{row.time}</div>
                                                        </td>
                                                        {DAYS.map(d => {
                                                            const cell = getCell(d, p);
                                                            return (
                                                                <td key={d} style={{ padding: '4px 3px', textAlign: 'center', verticalAlign: 'top' }}>
                                                                    {cell ? (
                                                                        <div style={{ padding: '7px 5px', borderRadius: 8, minHeight: 42, background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', transition: 'all 0.2s ease' }}
                                                                            onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.03)'; e.currentTarget.style.boxShadow = '0 4px 15px rgba(99,102,241,0.15)'; }}
                                                                            onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = 'none'; }}>
                                                                            <p style={{ fontSize: 11, fontWeight: 600, color: '#a5b4fc', lineHeight: 1.3 }}>{cell.subject_name}</p>
                                                                            <p style={{ fontSize: 9, color: '#64748b', marginTop: 2 }}>🎓 Y{cell.year}-{cell.section_name}</p>
                                                                        </div>
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

                    {/* Availability Tab */}
                    {activeTab === 'availability' && (
                        <motion.div key="avail" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                            <div style={{ borderRadius: 18, padding: 24, background: 'rgba(15,23,42,0.4)', border: '1px solid rgba(99,102,241,0.08)' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                        <Grid3X3 size={18} color="#6366f1" />
                                        <div>
                                            <h3 style={{ fontSize: 16, fontWeight: 600, color: '#f1f5f9' }}>Availability Matrix</h3>
                                            <p style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>Click slots to toggle available/unavailable. Admin uses this for scheduling.</p>
                                        </div>
                                    </div>
                                    <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={saveAvailability} disabled={savingAvail}
                                        className="btn-primary" style={{ padding: '10px 24px' }}>
                                        <span style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                                            <Save size={14} />{savingAvail ? 'Saving...' : 'Save Availability'}
                                        </span>
                                    </motion.button>
                                </div>

                                {/* Legend */}
                                <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
                                    <span style={{ fontSize: 11, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <span style={{ width: 16, height: 16, borderRadius: 4, background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)', display: 'inline-block' }} /> Available
                                    </span>
                                    <span style={{ fontSize: 11, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <span style={{ width: 16, height: 16, borderRadius: 4, background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', display: 'inline-block' }} /> Unavailable
                                    </span>
                                </div>

                                <div style={{ borderRadius: 14, overflow: 'auto', border: '1px solid rgba(99,102,241,0.08)' }}>
                                    <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
                                        <thead>
                                            <tr style={{ background: 'rgba(99,102,241,0.06)' }}>
                                                <th style={{ padding: '12px 14px', fontSize: 11, color: '#64748b', textAlign: 'left', fontWeight: 600, width: 100, borderBottom: '1px solid rgba(99,102,241,0.08)' }}>Period</th>
                                                {DAYS.map(d => (
                                                    <th key={d} style={{ padding: '12px 8px', fontSize: 12, color: '#94a3b8', textAlign: 'center', fontWeight: 600, borderBottom: '1px solid rgba(99,102,241,0.08)' }}>{d}</th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {SCHEDULE.map((row, idx) => {
                                                if (row.type === 'break') {
                                                    return (
                                                        <tr key={`break-${idx}`}>
                                                            <td colSpan={7} style={{ padding: '6px 14px', textAlign: 'center', fontSize: 11, color: '#fbbf24', background: 'rgba(251,191,36,0.03)', borderTop: '1px dashed rgba(251,191,36,0.1)', borderBottom: '1px dashed rgba(251,191,36,0.1)' }}>
                                                                {row.icon} {row.label}
                                                            </td>
                                                        </tr>
                                                    );
                                                }
                                                const p = row.period!;
                                                return (
                                                    <tr key={p} style={{ borderBottom: '1px solid rgba(99,102,241,0.04)' }}>
                                                        <td style={{ padding: '8px 14px', fontSize: 11, color: '#94a3b8', fontWeight: 500, background: 'rgba(99,102,241,0.02)' }}>
                                                            <div>P{p}</div>
                                                            <div style={{ fontSize: 9, color: '#475569' }}>{row.time}</div>
                                                        </td>
                                                        {DAYS.map(d => {
                                                            const isAvailable = availability[d]?.[p] !== false;
                                                            return (
                                                                <td key={d} style={{ padding: '4px', textAlign: 'center' }}>
                                                                    <motion.button
                                                                        whileHover={{ scale: 1.08 }} whileTap={{ scale: 0.92 }}
                                                                        onClick={() => toggleAvailability(d, p)}
                                                                        style={{
                                                                            width: '100%', minHeight: 38, borderRadius: 8, cursor: 'pointer',
                                                                            border: `1px solid ${isAvailable ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                                                                            background: isAvailable ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                                                                            color: isAvailable ? '#86efac' : '#fca5a5',
                                                                            fontSize: 13, fontWeight: 600, transition: 'all 0.2s ease',
                                                                        }}
                                                                    >
                                                                        {isAvailable ? '✓' : '✕'}
                                                                    </motion.button>
                                                                </td>
                                                            );
                                                        })}
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </motion.div>
                    )}

                    {/* Classes Tab */}
                    {activeTab === 'classes' && (
                        <motion.div key="cls" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                            {myClasses.length === 0 ? (
                                <div style={{ textAlign: 'center', padding: 60, borderRadius: 16, background: 'rgba(15,23,42,0.3)', border: '1px solid rgba(99,102,241,0.06)' }}>
                                    <BookOpen size={28} color="#475569" style={{ marginBottom: 8 }} /><p style={{ color: '#475569' }}>No classes assigned yet</p>
                                </div>
                            ) : myClasses.map((c, ci) => (
                                <motion.div key={c.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: ci * 0.05 }}
                                    style={{ padding: 22, marginBottom: 14, borderRadius: 18, background: 'rgba(15,23,42,0.4)', border: '1px solid rgba(99,102,241,0.08)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                            <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                <GraduationCap size={18} color="#6366f1" />
                                            </div>
                                            <div>
                                                <h3 style={{ fontSize: 15, fontWeight: 600, color: '#f1f5f9' }}>Year {c.year} — Section {c.section_name}</h3>
                                                <p style={{ fontSize: 11, color: '#64748b' }}>{c.students.length} students enrolled</p>
                                            </div>
                                        </div>
                                    </div>
                                    <div style={{ display: 'grid', gap: 4 }}>
                                        {c.students.map((s, si) => (
                                            <div key={s.id} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 1fr', alignItems: 'center', padding: '8px 14px', borderRadius: 10, background: si % 2 === 0 ? 'rgba(99,102,241,0.02)' : 'transparent' }}>
                                                <span style={{ color: '#f1f5f9', fontSize: 13 }}>{s.name}</span>
                                                <span style={{ color: '#818cf8', fontSize: 12, fontFamily: 'monospace' }}>{s.reg_no}</span>
                                                <span style={{ color: '#64748b', fontSize: 12, textAlign: 'right' }}>{s.email}</span>
                                            </div>
                                        ))}
                                    </div>
                                </motion.div>
                            ))}
                        </motion.div>
                    )}

                    {/* Interests Tab */}
                    {activeTab === 'interests' && (
                        <motion.div key="int" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                            <div style={{ borderRadius: 18, padding: 28, background: 'rgba(15,23,42,0.4)', border: '1px solid rgba(99,102,241,0.08)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
                                    <Heart size={18} color="#f43f5e" />
                                    <h3 style={{ fontSize: 16, fontWeight: 600, color: '#f1f5f9' }}>Subject Interests</h3>
                                    <span style={{ fontSize: 11, color: '#64748b' }}>({interests.length} selected)</span>
                                </div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 24 }}>
                                    {subjects.map(s => {
                                        const selected = interests.includes(s.id);
                                        return (
                                            <motion.button key={s.id} whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} onClick={() => toggleInterest(s.id)} style={{
                                                padding: '9px 18px', borderRadius: 20, fontSize: 13, cursor: 'pointer', fontWeight: selected ? 500 : 400,
                                                border: `1px solid ${selected ? 'rgba(99,102,241,0.4)' : 'rgba(99,102,241,0.12)'}`,
                                                background: selected ? 'linear-gradient(135deg, rgba(99,102,241,0.12), rgba(99,102,241,0.06))' : 'transparent',
                                                color: selected ? '#a5b4fc' : '#64748b', transition: 'all 0.2s ease',
                                            }}>{selected ? '✓ ' : ''}{s.name} {s.type === 'lab' && '🔬'}</motion.button>
                                        );
                                    })}
                                </div>
                                <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={saveInterests} className="btn-primary" style={{ padding: '10px 28px' }}>
                                    <span style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: 6 }}><Save size={14} />Save Interests</span>
                                </motion.button>
                            </div>
                        </motion.div>
                    )}

                    {/* Messages Tab */}
                    {activeTab === 'messages' && (
                        <motion.div key="msg" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                            {!activeConvo ? (
                                <div style={{ display: 'grid', gap: 8 }}>
                                    {convos.length === 0 ? (
                                        <div style={{ textAlign: 'center', padding: 50, borderRadius: 16, background: 'rgba(15,23,42,0.3)', border: '1px solid rgba(99,102,241,0.06)' }}>
                                            <MessageCircle size={28} color="#475569" style={{ marginBottom: 8 }} />
                                            <p style={{ color: '#475569', fontSize: 14 }}>No conversations yet</p>
                                        </div>
                                    ) : convos.map(c => (
                                        <motion.button key={c.id} whileHover={{ x: 4 }} onClick={() => openConvo(c)}
                                            style={{ padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', textAlign: 'left', cursor: 'pointer', borderRadius: 14, border: '1px solid rgba(99,102,241,0.08)', background: 'rgba(15,23,42,0.3)', transition: 'all 0.2s ease' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                                <div style={{ width: 38, height: 38, borderRadius: 10, background: 'rgba(99,102,241,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#818cf8', fontWeight: 600, fontSize: 14 }}>{c.other_name[0]}</div>
                                                <div>
                                                    <p style={{ fontSize: 14, fontWeight: 600, color: '#f1f5f9' }}>{c.other_name}</p>
                                                    <p style={{ fontSize: 12, color: '#475569', marginTop: 2 }}>{c.last_message || 'No messages yet'}</p>
                                                </div>
                                            </div>
                                            {c.unread && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#6366f1' }} />}
                                        </motion.button>
                                    ))}
                                </div>
                            ) : (
                                <div style={{ height: 520, display: 'flex', flexDirection: 'column', borderRadius: 18, background: 'rgba(15,23,42,0.4)', border: '1px solid rgba(99,102,241,0.1)', overflow: 'hidden' }}>
                                    <div style={{ padding: '14px 18px', borderBottom: '1px solid rgba(99,102,241,0.08)', display: 'flex', alignItems: 'center', gap: 12, background: 'rgba(99,102,241,0.03)' }}>
                                        <button onClick={() => setActiveConvo(null)} style={{ background: 'rgba(99,102,241,0.08)', border: 'none', color: '#94a3b8', cursor: 'pointer', width: 30, height: 30, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ChevronLeft size={18} /></button>
                                        <div style={{ width: 32, height: 32, borderRadius: 8, background: 'rgba(99,102,241,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#818cf8', fontWeight: 600, fontSize: 13 }}>{activeConvo.other_name[0]}</div>
                                        <p style={{ fontWeight: 600, color: '#f1f5f9', fontSize: 14 }}>{activeConvo.other_name}</p>
                                    </div>
                                    <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                        {messages.length === 0 && <p style={{ textAlign: 'center', color: '#475569', fontSize: 13, marginTop: 40 }}>Start the conversation...</p>}
                                        {messages.map(m => (
                                            <motion.div key={m.id} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}
                                                style={{ alignSelf: m.sender_id === profile?.id ? 'flex-end' : 'flex-start', maxWidth: '70%', padding: '10px 14px', borderRadius: 12, background: m.sender_id === profile?.id ? 'rgba(99,102,241,0.12)' : 'rgba(15,23,42,0.6)', border: `1px solid ${m.sender_id === profile?.id ? 'rgba(99,102,241,0.15)' : 'rgba(99,102,241,0.06)'}` }}>
                                                <p style={{ fontSize: 13, color: '#f1f5f9' }}>{m.content}</p>
                                                <p style={{ fontSize: 10, color: '#475569', marginTop: 4 }}>{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                                            </motion.div>
                                        ))}
                                    </div>
                                    <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(99,102,241,0.08)', display: 'flex', gap: 8 }}>
                                        <input value={msgInput} onChange={e => setMsgInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendMessage()} className="glass-input" placeholder="Type a message..." style={{ flex: 1, padding: '10px 14px' }} />
                                        <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={sendMessage} className="btn-primary" style={{ padding: '10px 16px' }}>
                                            <span style={{ position: 'relative', zIndex: 1 }}><Send size={16} /></span>
                                        </motion.button>
                                    </div>
                                </div>
                            )}
                        </motion.div>
                    )}

                    {/* Profile Tab */}
                    {activeTab === 'profile' && profile && (
                        <motion.div key="prof" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                            <div style={{ maxWidth: 500, borderRadius: 20, background: 'rgba(15,23,42,0.4)', border: '1px solid rgba(99,102,241,0.08)', overflow: 'hidden' }}>
                                <div style={{ padding: '32px 28px', textAlign: 'center', background: 'linear-gradient(135deg, rgba(139,92,246,0.1), rgba(99,102,241,0.06))' }}>
                                    <div style={{ width: 80, height: 80, borderRadius: 20, background: 'linear-gradient(135deg, #8b5cf6, #a78bfa)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', fontSize: 32, color: 'white', fontWeight: 700, boxShadow: '0 8px 30px rgba(139,92,246,0.3)' }}>{profile.name[0]}</div>
                                    <h2 style={{ fontSize: 20, fontWeight: 700, color: '#f1f5f9' }}>{profile.name}</h2>
                                    <span style={{ display: 'inline-block', padding: '4px 12px', borderRadius: 20, background: 'rgba(139,92,246,0.1)', color: '#c4b5fd', fontSize: 11, fontWeight: 500, marginTop: 6, border: '1px solid rgba(139,92,246,0.15)' }}>Faculty</span>
                                </div>
                                <div style={{ padding: '4px 28px 24px' }}>
                                    {[{ l: 'Email', v: profile.email }, { l: 'Department', v: profile.department || 'CSE' }, { l: 'Classes', v: `${myClasses.length} sections` }, { l: 'Periods/Week', v: `${totalClasses}` }].map(item => (
                                        <div key={item.l} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid rgba(99,102,241,0.04)' }}>
                                            <span style={{ color: '#64748b', fontSize: 13 }}>{item.l}</span>
                                            <span style={{ color: '#f1f5f9', fontSize: 13, fontWeight: 500 }}>{item.v}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
}
