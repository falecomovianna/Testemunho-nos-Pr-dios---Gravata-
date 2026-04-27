/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  collection, 
  query, 
  onSnapshot, 
  addDoc, 
  serverTimestamp, 
  doc,
  deleteDoc,
  updateDoc,
  getDocs,
  where,
  increment,
  writeBatch
} from 'firebase/firestore';
import { db } from './lib/firebase';
import { extractBuildingData, extractBuildingDataFromText, extractBuildingBoundingBox } from './lib/gemini';
import { Building, Visit } from './types';
import { cn, formatDate } from './lib/utils';
import { 
  Building2, 
  Plus, 
  Camera, 
  MapPin, 
  Search, 
  ChevronRight, 
  CheckCircle2, 
  XCircle, 
  ArrowLeft,
  Loader2,
  Trash2,
  Navigation,
  FileDown,
  X,
  ImageIcon,
  Edit,
  ShieldCheck,
  RefreshCw,
  History,
  Scissors
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import ReactCrop, { type Crop, type PixelCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';

// --- Funções Auxiliares de Imagem ---
async function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target?.result as string;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 1200;
        const scaleSize = MAX_WIDTH / img.width;
        canvas.width = MAX_WIDTH;
        canvas.height = img.height * scaleSize;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.7).split(',')[1]);
      };
    };
  });
}

export default function App() {
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [selectedBuilding, setSelectedBuilding] = useState<Building | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeFilter, setActiveFilter] = useState<'all' | 'started' | 'pending' | 'completed'>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessingText, setIsProcessingText] = useState(false);
  const [manualText, setManualText] = useState('');
  const [visits, setVisits] = useState<Visit[]>([]);
  
  // Modais
  const [showManualModal, setShowManualModal] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showAddAptModal, setShowAddAptModal] = useState(false);
  const [itemToDelete, setItemToDelete] = useState<{type: 'visit' | 'apartment' | 'building', id: string} | null>(null);
  const [showEditBuildingModal, setShowEditBuildingModal] = useState(false);
  const [editBuildingForm, setEditBuildingForm] = useState({name: '', buildingNumber: '', address: '', apartmentsCount: ''});
  const [showVisitModal, setShowVisitModal] = useState(false);
  const [activeApartment, setActiveApartment] = useState<string | null>(null);
  
  // Estados de Controle
  const [newAptName, setNewAptName] = useState('');
  const [reportPassword, setReportPassword] = useState('');
  const [isUpdatingBuilding, setIsUpdatingBuilding] = useState(false);
  const [isSavingVisit, setIsSavingVisit] = useState(false);
  const [isSyncingStats, setIsSyncingStats] = useState(false);
  const [view, setView] = useState<'list' | 'building' | 'add'>('list');
  const [visitContacted, setVisitContacted] = useState(true);
  const [visitNotes, setVisitNotes] = useState('');
  const [editingVisitId, setEditingVisitId] = useState<string | null>(null);
  
  // Crop
  const [showCropModal, setShowCropModal] = useState(false);
  const [cropImageBase64, setCropImageBase64] = useState<string>('');
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const facadeInputRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // --- LÓGICA DE STATUS CENTRALIZADA (CORREÇÃO CLAUDE) ---
  const getBuildingStatus = (b: Building) => {
    const totalApts = b.apartments?.length || 0;
    const visitsDone = b.visitCount || 0;

    // Se não tem apartamentos cadastrados, está sempre pendente (evita erro do .every())
    if (totalApts === 0) return 'pending';

    // Para saber se está completo, precisamos checar se cada apto tem uma visita
    // No modo lista, usamos a marcação do banco. No detalhe, usamos o isCompleted real.
    if (b.isCompleted && visitsDone >= totalApts && totalApts > 0) return 'completed';
    if (visitsDone > 0) return 'started';
    return 'pending';
  };

  const stats = {
    total: buildings.length,
    started: buildings.filter(b => getBuildingStatus(b) === 'started').length,
    completed: buildings.filter(b => getBuildingStatus(b) === 'completed').length,
    pending: buildings.filter(b => getBuildingStatus(b) === 'pending').length
  };

  const filteredBuildings = buildings.filter(b => {
    const status = getBuildingStatus(b);
    if (activeFilter === 'started' && status !== 'started') return false;
    if (activeFilter === 'pending' && status !== 'pending') return false;
    if (activeFilter === 'completed' && status !== 'completed') return false;

    if (!searchTerm.trim()) return true;
    const term = searchTerm.trim().toLowerCase();
    return (
      b.buildingNumber.includes(term) || 
      b.address.toLowerCase().includes(term) || 
      (b.name && b.name.toLowerCase().includes(term))
    );
  });

  // --- EFEITOS E FIREBASE ---
  useEffect(() => {
    const q = query(collection(db, 'buildings'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Building));
      setBuildings(data.sort((a, b) => a.buildingNumber.localeCompare(b.buildingNumber, undefined, { numeric: true })));
      setIsLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!selectedBuilding) return;
    const q = query(collection(db, `buildings/${selectedBuilding.id}/visits`));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Visit));
      setVisits(data.sort((a: any, b: any) => (b.date?.toDate?.() || 0) - (a.date?.toDate?.() || 0)));
      
      // Sincroniza status do prédio atual
      const visitedApts = new Set(data.map(v => v.apartment));
      const totalApts = selectedBuilding.apartments.length;
      const isDone = totalApts > 0 && selectedBuilding.apartments.every(apt => visitedApts.has(apt));

      if (selectedBuilding.visitCount !== snapshot.size || selectedBuilding.isCompleted !== isDone) {
        updateDoc(doc(db, 'buildings', selectedBuilding.id), {
          visitCount: snapshot.size,
          isCompleted: isDone
        });
      }
    });
    return () => unsubscribe();
  }, [selectedBuilding?.id]);

  // --- MANIPULADORES ---
  const handleTextUpload = async () => {
    if (!manualText.trim()) return;
    setIsProcessingText(true);
    try {
      const extracted = await extractBuildingDataFromText(manualText);
      const docRef = await addDoc(collection(db, 'buildings'), {
        ...extracted,
        visitCount: 0,
        isCompleted: false,
        createdAt: serverTimestamp()
      });
      setSelectedBuilding({ id: docRef.id, ...extracted } as Building);
      setView('building');
      setShowManualModal(false);
      setManualText('');
    } catch (e) { alert("Erro ao processar texto."); }
    finally { setIsProcessingText(false); }
  };

  const handleSaveVisit = async () => {
    if (!selectedBuilding || !activeApartment) return;
    setIsSavingVisit(true);
    try {
      const visitPath = `buildings/${selectedBuilding.id}/visits`;
      if (editingVisitId) {
        await updateDoc(doc(db, visitPath, editingVisitId), { contacted: visitContacted, notes: visitNotes, updatedAt: serverTimestamp() });
      } else {
        await addDoc(collection(db, visitPath), { apartment: activeApartment, contacted: visitContacted, notes: visitNotes, date: serverTimestamp() });
        await updateDoc(doc(db, 'buildings', selectedBuilding.id), { visitCount: increment(1) });
      }
      setShowVisitModal(false);
    } catch (e) { alert("Erro ao salvar."); }
    finally { setIsSavingVisit(false); }
  };

  const openInMaps = (address: string) => {
    window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`, '_blank');
  };

  if (isLoading) return <div className="flex h-screen items-center justify-center"><Loader2 className="animate-spin text-blue-600" /></div>;

  return (
    <div className="min-h-screen bg-slate-100 pb-20 font-sans">
      <header className="sticky top-0 z-30 bg-white border-b px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-4">
          {view !== 'list' && (
            <button onClick={() => setView('list')} className="p-2 text-slate-500 hover:bg-slate-50 rounded-lg">
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
          <div className="flex items-center gap-3">
             <div className="w-10 h-10 bg-slate-900 rounded-xl flex items-center justify-center text-white"><Building2 className="w-6 h-6" /></div>
             <div>
                <h1 className="font-bold text-lg text-slate-900">{view === 'list' ? 'Testemunhos nos Prédios' : selectedBuilding?.name || 'Detalhes'}</h1>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Gestão de Território</p>
             </div>
          </div>
        </div>
      </header>

      <main className="max-w-xl mx-auto p-4">
        {view === 'list' && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Total', val: stats.total, filter: 'all', color: 'bg-slate-900' },
                { label: 'Iniciados', val: stats.started, filter: 'started', color: 'bg-blue-600' },
                { label: 'Concluídos', val: stats.completed, filter: 'completed', color: 'bg-emerald-600' },
                { label: 'Não Trabalhado', val: stats.pending, filter: 'pending', color: 'bg-amber-500' }
              ].map(item => (
                <button key={item.label} onClick={() => setActiveFilter(item.filter as any)} className={cn("p-4 rounded-3xl border transition-all", activeFilter === item.filter ? `${item.color} text-white shadow-lg` : "bg-white text-slate-900")}>
                  <span className="block text-2xl font-black">{item.val}</span>
                  <span className="text-[8px] font-bold uppercase tracking-widest opacity-60">{item.label}</span>
                </button>
              ))}
            </div>

            <div className="relative group">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-blue-500" />
              <input type="text" placeholder="Buscar prédio ou endereço..." className="w-full pl-11 pr-4 py-3 bg-white border rounded-xl text-sm outline-none shadow-sm" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
            </div>

            <div className="grid gap-3">
              {filteredBuildings.map(b => (
                <div key={b.id} onClick={() => { setSelectedBuilding(b); setView('building'); }} className="bg-white p-4 rounded-2xl border flex items-center justify-between cursor-pointer hover:border-blue-300 transition-all shadow-sm group">
                  <div className="flex-1 min-w-0 pr-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="px-3 py-1 bg-blue-600 text-white text-[10px] rounded-lg font-black uppercase">Nº {b.buildingNumber}</span>
                      {getBuildingStatus(b) === 'completed' && <span className="px-2 py-1 bg-emerald-100 text-emerald-700 text-[10px] rounded-lg font-black uppercase">Concluído</span>}
                    </div>
                    <h3 className="font-bold text-slate-900 group-hover:text-blue-600 truncate">{b.name || 'Sem nome'}</h3>
                    <p className="text-xs text-slate-500 truncate mt-1 flex items-center gap-1"><MapPin className="w-3 h-3" /> {b.address}</p>
                  </div>
                  <ChevronRight className="w-5 h-5 text-slate-300 group-hover:text-blue-500" />
                </div>
              ))}
            </div>
          </div>
        )}

        {view === 'building' && selectedBuilding && (
          <div className="space-y-6 pb-24">
            <div className="bg-white rounded-3xl border overflow-hidden shadow-xl">
              <div className="h-48 bg-slate-100 relative">
                {selectedBuilding.facadeImageUrl ? <img src={selectedBuilding.facadeImageUrl} className="w-full h-full object-cover" /> : <div className="w-full h-full flex flex-col items-center justify-center text-slate-300 uppercase text-[10px] font-bold">Sem Foto da Fachada</div>}
                <div className="absolute top-4 left-4">
                   <span className={cn("px-3 py-1.5 text-white text-[10px] font-black uppercase rounded-full shadow-lg", getBuildingStatus(selectedBuilding) === 'completed' ? 'bg-emerald-500' : 'bg-slate-500')}>{getBuildingStatus(selectedBuilding) === 'completed' ? 'Concluído' : 'Em progresso'}</span>
                </div>
              </div>
              <div className="bg-slate-900 px-6 py-4 flex items-center justify-between">
                 <div className="text-white">
                    <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Prédio</p>
                    <p className="font-black text-2xl">{selectedBuilding.buildingNumber}</p>
                 </div>
                 <button onClick={() => openInMaps(selectedBuilding.address)} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-xs font-bold rounded-xl shadow-lg shadow-blue-500/20"><Navigation className="w-4 h-4" /> GPS</button>
              </div>
              <div className="p-6">
                 <p className="text-slate-900 font-bold text-lg leading-tight">{selectedBuilding.address}</p>
                 <p className="text-blue-600 font-medium text-sm mt-1">{selectedBuilding.name}</p>
              </div>
            </div>

            <div className="bg-slate-900 rounded-3xl p-6 text-white shadow-xl relative overflow-hidden">
               <h4 className="text-xs font-bold opacity-40 uppercase tracking-[0.2em] mb-6">Resumo da Cobertura</h4>
               <div className="flex justify-between relative z-10">
                  <div className="text-center">
                    <span className="block text-3xl font-black italic">{new Set(visits.map(v => v.apartment)).size}</span>
                    <span className="text-[8px] font-bold opacity-50 uppercase">Visitados</span>
                  </div>
                  <div className="w-px h-10 bg-white/10" />
                  <div className="text-center">
                    <span className="block text-3xl font-black italic">{Math.max(0, selectedBuilding.apartments.length - new Set(visits.map(v => v.apartment)).size)}</span>
                    <span className="text-[8px] font-bold opacity-50 uppercase">Faltam</span>
                  </div>
                  <div className="w-px h-10 bg-white/10" />
                  <div className="text-center">
                    <span className="block text-3xl font-black italic text-blue-400">{selectedBuilding.apartments.length > 0 ? Math.round((new Set(visits.map(v => v.apartment)).size / selectedBuilding.apartments.length) * 100) : 0}%</span>
                    <span className="text-[8px] font-bold opacity-50 uppercase">Alcance</span>
                  </div>
               </div>
            </div>

            <div className="space-y-4">
               <h4 className="font-bold text-sm flex items-center gap-2"><span className="w-1 h-4 bg-blue-600 rounded-full" /> Apartamentos</h4>
               <div className="grid grid-cols-4 gap-3">
                  {selectedBuilding.apartments.map(apt => {
                    const lastVisit = visits.find(v => v.apartment === apt);
                    return (
                      <button key={apt} onClick={() => { setActiveApartment(apt); if(lastVisit) { setVisitContacted(lastVisit.contacted); setVisitNotes(lastVisit.notes || ''); setEditingVisitId(lastVisit.id); } else { setVisitContacted(true); setVisitNotes(''); setEditingVisitId(null); } setShowVisitModal(true); }} className={cn("p-4 py-6 rounded-2xl border-2 flex flex-col items-center transition-all active:scale-95", lastVisit ? (lastVisit.contacted ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-700') : 'bg-white border-white text-slate-500 shadow-sm')}>
                         <span className="text-xl font-black tracking-tighter">{apt}</span>
                         {lastVisit && <span className="text-[8px] font-bold uppercase mt-2">{lastVisit.contacted ? 'SIM' : 'NÃO'}</span>}
                      </button>
                    )
                  })}
               </div>
            </div>
          </div>
        )}
      </main>

      {/* FAB Fixo */}
      <div className="fixed bottom-6 right-6 z-40">
        <button onClick={() => setShowManualModal(true)} className="bg-blue-600 text-white w-16 h-16 rounded-full shadow-2xl flex items-center justify-center hover:scale-110 active:scale-95 transition-all">
          <Plus className="w-8 h-8" />
        </button>
      </div>

      {/* MODAL MANUAL */}
      <AnimatePresence>
        {showManualModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowManualModal(false)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" />
            <motion.div initial={{ y: 50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="relative bg-white w-full max-w-lg rounded-[2.5rem] p-8 shadow-2xl">
               <h3 className="text-2xl font-black text-slate-900 mb-2">Novo Prédio</h3>
               <p className="text-xs text-slate-400 uppercase tracking-widest font-bold mb-6">Descreva o endereço e apartamentos</p>
               <textarea value={manualText} onChange={(e) => setManualText(e.target.value)} placeholder="Rua Central 100, 4 aptos: 101, 102, 201, 202..." className="w-full p-5 bg-slate-50 border-none rounded-3xl text-sm min-h-[150px] outline-none" />
               <button onClick={handleTextUpload} disabled={isProcessingText || !manualText.trim()} className="w-full py-5 bg-blue-600 text-white rounded-[2rem] font-black text-lg mt-6 shadow-xl shadow-blue-500/20 disabled:opacity-50">{isProcessingText ? <Loader2 className="animate-spin mx-auto" /> : "Cadastrar"}</button>
            </motion.div>
          </div>
        )}

        {showVisitModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowVisitModal(false)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" />
            <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} className="relative bg-white w-full max-w-lg rounded-[2.5rem] p-8 shadow-2xl">
               <h3 className="text-2xl font-black mb-6">Apto {activeApartment}</h3>
               <div className="grid grid-cols-2 gap-4 mb-6">
                  <button onClick={() => setVisitContacted(true)} className={cn("py-4 rounded-2xl font-black transition-all", visitContacted ? 'bg-green-100 text-green-700 ring-2 ring-green-500' : 'bg-slate-50 text-slate-400')}>SIM</button>
                  <button onClick={() => setVisitContacted(false)} className={cn("py-4 rounded-2xl font-black transition-all", !visitContacted ? 'bg-red-100 text-red-700 ring-2 ring-red-500' : 'bg-slate-50 text-slate-400')}>NÃO</button>
               </div>
               <textarea value={visitNotes} onChange={(e) => setVisitNotes(e.target.value)} placeholder="Alguma observação importante?" className="w-full p-5 bg-slate-50 rounded-3xl min-h-[120px] outline-none mb-6" />
               <button onClick={handleSaveVisit} disabled={isSavingVisit} className="w-full py-5 bg-slate-900 text-white rounded-[2rem] font-black shadow-xl">{isSavingVisit ? <Loader2 className="animate-spin mx-auto" /> : "Salvar Visita"}</button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
