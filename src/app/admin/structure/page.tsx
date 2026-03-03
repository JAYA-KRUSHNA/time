'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { Plus, Trash2 } from 'lucide-react';

interface Section { id: string; department_id: string; year: number; section_name: string; student_count: number; max_capacity: number; }

export default function CollegeStructurePage() {
    const [sections, setSections] = useState<Section[]>([]);
    const [selectedYear, setSelectedYear] = useState(1);
    const [loading, setLoading] = useState(true);
    const [adding, setAdding] = useState(false);
    const [newSection, setNewSection] = useState('');

    const loadSections = async () => {
        const res = await fetch('/api/sections');
        const data = await res.json();
        setSections(Array.isArray(data) ? data : []);
        setLoading(false);
    };

    useEffect(() => { loadSections(); }, []);

    const filtered = sections.filter(s => s.year === selectedYear);

    const addSection = async () => {
        if (!newSection.trim()) return;
        setAdding(true);
        const res = await fetch('/api/sections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ year: selectedYear, section_name: newSection.trim().toUpperCase(), max_capacity: 70 }) });
        const data = await res.json();
        if (res.ok) { toast.success('Section added'); setNewSection(''); loadSections(); } else toast.error(data.error);
        setAdding(false);
    };

    const deleteSection = async (id: string) => {
        const res = await fetch(`/api/sections?id=${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (res.ok) { toast.success('Deleted'); loadSections(); } else toast.error(data.error);
    };

    if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" style={{ width: 32, height: 32 }} /></div>;

    return (
        <div>
            <h1 style={{ fontSize: 26, fontWeight: 700, color: '#f1f5f9', marginBottom: 4 }}>College Structure</h1>
            <p style={{ color: '#94a3b8', fontSize: 14, marginBottom: 24 }}>Manage sections and capacity</p>

            <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
                {[1, 2, 3, 4].map(y => (
                    <button key={y} onClick={() => setSelectedYear(y)} style={{
                        padding: '10px 20px', borderRadius: 10, fontSize: 14, cursor: 'pointer',
                        border: `1px solid ${selectedYear === y ? 'rgba(99,102,241,0.4)' : 'rgba(99,102,241,0.15)'}`,
                        background: selectedYear === y ? 'rgba(99,102,241,0.12)' : 'transparent',
                        color: selectedYear === y ? '#818cf8' : '#94a3b8', fontWeight: selectedYear === y ? 600 : 400,
                    }}>Year {y}</button>
                ))}
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
                <input value={newSection} onChange={e => setNewSection(e.target.value)} className="glass-input" placeholder="Section name (e.g. D)" style={{ width: 200 }} />
                <button onClick={addSection} disabled={adding} className="btn-primary" style={{ padding: '12px 20px' }}>
                    <span style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: 6 }}><Plus size={16} />{adding ? '...' : 'Add'}</span>
                </button>
            </div>

            <div style={{ display: 'grid', gap: 10 }}>
                {filtered.map((s, i) => (
                    <motion.div key={s.id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }} className="glass-card" style={{ padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                            <p style={{ fontSize: 16, fontWeight: 600, color: '#f1f5f9' }}>Section {s.section_name}</p>
                            <p style={{ fontSize: 12, color: '#64748b' }}>{s.student_count} / {s.max_capacity} students</p>
                            <div style={{ width: 120, height: 4, borderRadius: 2, background: 'rgba(99,102,241,0.1)', marginTop: 6 }}>
                                <div style={{ width: `${(s.student_count / s.max_capacity) * 100}%`, height: '100%', borderRadius: 2, background: s.student_count >= s.max_capacity ? '#ef4444' : '#6366f1' }} />
                            </div>
                        </div>
                        {s.student_count === 0 && <button onClick={() => deleteSection(s.id)} style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer' }}><Trash2 size={16} /></button>}
                    </motion.div>
                ))}
                {filtered.length === 0 && <div className="glass" style={{ textAlign: 'center', padding: 40, color: '#64748b' }}>No sections for Year {selectedYear}</div>}
            </div>
        </div>
    );
}
