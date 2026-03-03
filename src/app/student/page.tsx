'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';
import { Calendar, Users, MessageCircle, User, Download, Send, ChevronLeft } from 'lucide-react';

interface Profile { id: string; role: string; name: string; email: string; reg_no?: string; year?: number; section?: string; department?: string; }
interface TimetableEntry { day: string; period: number; subject_name: string; subject_type: string; room_name?: string; lab_name?: string; }
interface FacultyMember { id: string; name: string; email: string; department: string; }
interface ConvoItem { id: string; other_name: string; other_id: string; last_message?: string; unread: boolean; }
interface MsgItem { id: string; content: string; sender_id: string; sender_name: string; created_at: string; }

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const PERIODS = [1, 2, 3, 4, 5, 6, 7];
const tabs = [
    { id: 'timetable', label: 'Timetable', icon: Calendar },
    { id: 'faculty', label: 'Faculty', icon: Users },
    { id: 'messages', label: 'Messages', icon: MessageCircle },
    { id: 'profile', label: 'Profile', icon: User },
];

export default function StudentDashboard() {
    const router = useRouter();
    const [activeTab, setActiveTab] = useState('timetable');
    const [profile, setProfile] = useState<Profile | null>(null);
    const [timetable, setTimetable] = useState<TimetableEntry[]>([]);
    const [faculty, setFaculty] = useState<FacultyMember[]>([]);
    const [convos, setConvos] = useState<ConvoItem[]>([]);
    const [messages, setMessages] = useState<MsgItem[]>([]);
    const [activeConvo, setActiveConvo] = useState<ConvoItem | null>(null);
    const [msgInput, setMsgInput] = useState('');
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function load() {
            const [pRes, ttRes, fRes, cRes] = await Promise.all([
                fetch('/api/data?table=profile'), fetch('/api/data?table=my-timetable'),
                fetch('/api/data?table=faculty'), fetch('/api/data?table=conversations'),
            ]);
            setProfile(await pRes.json()); setTimetable(await ttRes.json());
            setFaculty(await fRes.json()); setConvos(await cRes.json());
            setLoading(false);
        }
        load();
    }, []);

    const getCell = (day: string, period: number) => timetable.find(t => t.day === day && t.period === period);

    const exportCSV = () => {
        let csv = 'Period,' + DAYS.join(',') + '\n';
        PERIODS.forEach(p => { csv += p + ','; DAYS.forEach((d, i) => { const c = getCell(d, p); csv += (c ? c.subject_name : '-') + (i < DAYS.length - 1 ? ',' : ''); }); csv += '\n'; });
        const blob = new Blob([csv], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'timetable.csv'; a.click();
    };

    const openConvo = async (convo: ConvoItem) => {
        setActiveConvo(convo);
        const res = await fetch(`/api/data?table=messages&conversation_id=${convo.id}`);
        setMessages(await res.json());
    };

    const sendMessage = async () => {
        if (!msgInput.trim() || !activeConvo) return;
        await fetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'send-message', conversation_id: activeConvo.id, content: msgInput.trim() }) });
        setMsgInput('');
        const res = await fetch(`/api/data?table=messages&conversation_id=${activeConvo.id}`);
        setMessages(await res.json());
    };

    const startConvo = async (facultyId: string) => {
        const res = await fetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create-conversation', other_id: facultyId }) });
        const data = await res.json();
        const fac = faculty.find(f => f.id === facultyId);
        setActiveConvo({ id: data.id, other_name: fac?.name || 'Faculty', other_id: facultyId, unread: false });
        setMessages([]);
        setActiveTab('messages');
    };

    const handleLogout = async () => { try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { } router.push('/select-role'); };

    if (loading) return <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}><div className="spinner" style={{ width: 40, height: 40 }} /></div>;

    return (
        <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%)' }}>
            <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
                    <div><h1 style={{ fontSize: 24, fontWeight: 700, color: '#f1f5f9' }}>Welcome, {profile?.name}</h1><p style={{ color: '#94a3b8', fontSize: 13 }}>{profile?.reg_no} · Year {profile?.year} · Section {profile?.section}</p></div>
                    <button onClick={handleLogout} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.1)', color: '#f87171', fontSize: 13, cursor: 'pointer' }}>Logout</button>
                </div>

                <div style={{ display: 'flex', gap: 6, marginBottom: 24 }}>
                    {tabs.map(tab => (
                        <button key={tab.id} onClick={() => { setActiveTab(tab.id); if (tab.id !== 'messages') setActiveConvo(null); }} style={{
                            display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px', borderRadius: 10,
                            border: `1px solid ${activeTab === tab.id ? 'rgba(99,102,241,0.4)' : 'rgba(99,102,241,0.1)'}`,
                            background: activeTab === tab.id ? 'rgba(99,102,241,0.12)' : 'transparent',
                            color: activeTab === tab.id ? '#818cf8' : '#94a3b8', fontWeight: activeTab === tab.id ? 600 : 400, fontSize: 14, cursor: 'pointer',
                        }}><tab.icon size={16} />{tab.label}</button>
                    ))}
                </div>

                <AnimatePresence mode="wait">
                    {activeTab === 'timetable' && (
                        <motion.div key="tt" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 12 }}>
                                <button onClick={exportCSV} className="btn-primary" style={{ padding: '8px 16px', fontSize: 13 }}><span style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: 6 }}><Download size={14} />Export CSV</span></button>
                            </div>
                            {timetable.length === 0 ? <div className="glass" style={{ textAlign: 'center', padding: 60, color: '#64748b' }}>No timetable generated yet</div> : (
                                <div className="glass" style={{ overflow: 'auto' }}>
                                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                        <thead><tr><th style={{ padding: '10px 12px', fontSize: 12, color: '#64748b', textAlign: 'left' }}>Period</th>{DAYS.map(d => <th key={d} style={{ padding: '10px 12px', fontSize: 12, color: '#64748b', textAlign: 'center' }}>{d}</th>)}</tr></thead>
                                        <tbody>{PERIODS.map(p => (
                                            <tr key={p}><td style={{ padding: '8px 12px', fontSize: 13, color: '#94a3b8', fontWeight: 600 }}>{p}</td>
                                                {DAYS.map(d => {
                                                    const cell = getCell(d, p); return (
                                                        <td key={d} style={{ padding: '6px 8px', textAlign: 'center' }}>
                                                            {cell ? <div style={{ padding: '8px 6px', borderRadius: 8, background: cell.subject_type === 'lab' ? 'rgba(34,197,94,0.1)' : 'rgba(99,102,241,0.1)', border: `1px solid ${cell.subject_type === 'lab' ? 'rgba(34,197,94,0.2)' : 'rgba(99,102,241,0.2)'}` }}>
                                                                <p style={{ fontSize: 12, fontWeight: 600, color: '#f1f5f9' }}>{cell.subject_name}</p>
                                                                <p style={{ fontSize: 10, color: '#64748b' }}>{cell.room_name || cell.lab_name || ''}</p>
                                                            </div> : <span style={{ color: '#334155', fontSize: 11 }}>—</span>}
                                                        </td>);
                                                })}
                                            </tr>
                                        ))}</tbody>
                                    </table>
                                </div>
                            )}
                        </motion.div>
                    )}

                    {activeTab === 'faculty' && (
                        <motion.div key="fac" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
                                {faculty.map(f => (
                                    <div key={f.id} className="glass-card" style={{ padding: 18 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                            <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(99,102,241,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#818cf8', fontWeight: 700 }}>{f.name[0]}</div>
                                            <div><p style={{ fontSize: 14, fontWeight: 600, color: '#f1f5f9' }}>{f.name}</p><p style={{ fontSize: 12, color: '#64748b' }}>{f.email}</p></div>
                                        </div>
                                        <button onClick={() => startConvo(f.id)} style={{ marginTop: 12, width: '100%', padding: '8px', borderRadius: 8, border: '1px solid rgba(99,102,241,0.2)', background: 'rgba(99,102,241,0.08)', color: '#818cf8', fontSize: 12, cursor: 'pointer' }}>Message</button>
                                    </div>
                                ))}
                                {faculty.length === 0 && <div className="glass" style={{ textAlign: 'center', padding: 40, color: '#64748b', gridColumn: '1/-1' }}>No faculty registered yet</div>}
                            </div>
                        </motion.div>
                    )}

                    {activeTab === 'messages' && (
                        <motion.div key="msg" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                            {!activeConvo ? (
                                <div style={{ display: 'grid', gap: 8 }}>
                                    {convos.length === 0 ? <div className="glass" style={{ textAlign: 'center', padding: 40, color: '#64748b' }}>No conversations yet. Message a faculty member to start.</div> : convos.map(c => (
                                        <button key={c.id} onClick={() => openConvo(c)} className="glass-card" style={{ padding: '14px 18px', display: 'flex', justifyContent: 'space-between', width: '100%', textAlign: 'left', cursor: 'pointer', border: 'none' }}>
                                            <div><p style={{ fontSize: 14, fontWeight: 600, color: '#f1f5f9' }}>{c.other_name}</p><p style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{c.last_message || 'No messages'}</p></div>
                                            {c.unread && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#6366f1' }} />}
                                        </button>
                                    ))}
                                </div>
                            ) : (
                                <div className="glass" style={{ height: 500, display: 'flex', flexDirection: 'column' }}>
                                    <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(99,102,241,0.1)', display: 'flex', alignItems: 'center', gap: 12 }}>
                                        <button onClick={() => setActiveConvo(null)} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}><ChevronLeft size={20} /></button>
                                        <p style={{ fontWeight: 600, color: '#f1f5f9' }}>{activeConvo.other_name}</p>
                                    </div>
                                    <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                        {messages.map(m => (
                                            <div key={m.id} style={{ alignSelf: m.sender_id === profile?.id ? 'flex-end' : 'flex-start', maxWidth: '70%', padding: '10px 14px', borderRadius: 12, background: m.sender_id === profile?.id ? 'rgba(99,102,241,0.15)' : 'rgba(30,30,60,0.5)' }}>
                                                <p style={{ fontSize: 13, color: '#f1f5f9' }}>{m.content}</p>
                                                <p style={{ fontSize: 10, color: '#64748b', marginTop: 4 }}>{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                                            </div>
                                        ))}
                                    </div>
                                    <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(99,102,241,0.1)', display: 'flex', gap: 8 }}>
                                        <input value={msgInput} onChange={e => setMsgInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendMessage()} className="glass-input" placeholder="Type a message..." style={{ flex: 1 }} />
                                        <button onClick={sendMessage} className="btn-primary" style={{ padding: '10px 16px' }}><span style={{ position: 'relative', zIndex: 1 }}><Send size={16} /></span></button>
                                    </div>
                                </div>
                            )}
                        </motion.div>
                    )}

                    {activeTab === 'profile' && profile && (
                        <motion.div key="prof" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                            <div className="glass" style={{ padding: 28, maxWidth: 500 }}>
                                <div style={{ textAlign: 'center', marginBottom: 24 }}>
                                    <div style={{ width: 80, height: 80, borderRadius: '50%', background: 'rgba(99,102,241,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', fontSize: 32, color: '#818cf8', fontWeight: 700 }}>{profile.name[0]}</div>
                                    <h2 style={{ fontSize: 20, fontWeight: 700, color: '#f1f5f9' }}>{profile.name}</h2>
                                    <p style={{ color: '#94a3b8', fontSize: 13 }}>Student</p>
                                </div>
                                {[{ l: 'Email', v: profile.email }, { l: 'Reg No', v: profile.reg_no }, { l: 'Year', v: `${profile.year}` }, { l: 'Section', v: profile.section }, { l: 'Department', v: profile.department }].map(item => (
                                    <div key={item.l} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid rgba(99,102,241,0.06)' }}>
                                        <span style={{ color: '#64748b', fontSize: 13 }}>{item.l}</span>
                                        <span style={{ color: '#f1f5f9', fontSize: 13 }}>{item.v}</span>
                                    </div>
                                ))}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
}
