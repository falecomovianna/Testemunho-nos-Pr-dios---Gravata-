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

async function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onerror = () => reject(new Error('Falha ao ler o arquivo de imagem.'));
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target?.result as string;
      img.onerror = () => reject(new Error('Falha ao carregar a imagem.'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 800;
        const scaleSize = MAX_WIDTH / img.width;
        canvas.width = MAX_WIDTH;
        canvas.height = img.height * scaleSize;

        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);

        const base64 = canvas.toDataURL('image/jpeg', 0.7);
        resolve(base64.split(',')[1]);
      };
    };
  });
}

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

export default function App() {
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [selectedBuilding, setSelectedBuilding] = useState<Building | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeFilter, setActiveFilter] = useState<'all' | 'started' | 'pending' | 'completed'>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [isProcessingText, setIsProcessingText] = useState(false);
  const [manualText, setManualText] = useState('');
  
  const [showManualModal, setShowManualModal] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showAddAptModal, setShowAddAptModal] = useState(false);
  const [itemToDelete, setItemToDelete] = useState<{type: 'visit' | 'apartment' | 'building', id: string} | null>(null);
  const [showEditBuildingModal, setShowEditBuildingModal] = useState(false);
  const [editBuildingForm, setEditBuildingForm] = useState({name: '', buildingNumber: '', address: '', apartmentsCount: '', observations: ''});

  const [newAptName, setNewAptName] = useState('');
  const [reportPassword, setReportPassword] = useState('');
  const [isUpdatingBuilding, setIsUpdatingBuilding] = useState(false);
  const [view, setView] = useState<'list' | 'building' | 'add'>('list');
  const facadeInputRef = useRef<HTMLInputElement>(null);

  const [showVisitModal, setShowVisitModal] = useState(false);
  const [activeApartment, setActiveApartment] = useState<string | null>(null);
  const [visitContacted, setVisitContacted] = useState(true);
  const [visitNotes, setVisitNotes] = useState('');
  const [editingVisitId, setEditingVisitId] = useState<string | null>(null);
  const [isSavingVisit, setIsSavingVisit] = useState(false);
  const [notesUnlocked, setNotesUnlocked] = useState(false);
  const [isSyncingStats, setIsSyncingStats] = useState(false);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [showLocationPrompt, setShowLocationPrompt] = useState(false);
  
  const [showCropModal, setShowCropModal] = useState(false);
  const [cropImageBase64, setCropImageBase64] = useState<string>('');
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if ('permissions' in navigator) {
      navigator.permissions.query({ name: 'geolocation' }).then((result) => {
        if (result.state === 'prompt') setShowLocationPrompt(true);
      });
    } else {
      setShowLocationPrompt(true);
    }
  }, []);

  const requestLocation = () => {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(() => setShowLocationPrompt(false), () => setShowLocationPrompt(false));
    } else {
      setShowLocationPrompt(false);
    }
  };

  useEffect(() => {
    const q = query(collection(db, 'buildings'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() } as Building))
        .sort((a, b) => a.buildingNumber.localeCompare(b.buildingNumber, undefined, { numeric: true, sensitivity: 'base' }));
      setBuildings(data);
      setIsLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!selectedBuilding) {
      setVisits([]);
      return;
    }
    const buildingId = selectedBuilding.id;
    const q = query(collection(db, `buildings/${buildingId}/visits`));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() } as Visit))
        .sort((a: any, b: any) => (b.date?.toDate?.() || 0) - (a.date?.toDate?.() || 0));
      setVisits(data);

      setBuildings(prevBuildings => {
        const currentBuilding = prevBuildings.find(b => b.id === buildingId);
        if (!currentBuilding) return prevBuildings;

        const visitedApts = new Set(data.map(v => v.apartment));
        const totalApts = currentBuilding.apartments.length;
        const isCompleted = totalApts > 0 && currentBuilding.apartments.every(apt => visitedApts.has(apt));

        if (currentBuilding.visitCount !== snapshot.size || currentBuilding.isCompleted !== isCompleted) {
          const buildingRef = doc(db, 'buildings', buildingId);
          updateDoc(buildingRef, {
            visitCount: snapshot.size,
            isCompleted: isCompleted,
            lastVisitDate: data.length > 0 ? data[0].date : null
          }).catch(err => console.error("Error syncing stats:", err));
        }
        return prevBuildings;
      });
    });
    return () => unsubscribe();
  }, [selectedBuilding?.id]);

  const handleTextUpload = async () => {
    if (!manualText.trim()) return;
    setIsProcessingText(true);
    try {
      const extracted = await extractBuildingDataFromText(manualText);
      const docRef = await addDoc(collection(db, 'buildings'), {
        ...extracted,
        ownerId: 'team_public',
        createdAt: serverTimestamp(),
        visitCount: 0,
        isCompleted: false
      });
      setSelectedBuilding({ id: docRef.id, ...extracted } as Building);
      setView('building');
      setShowManualModal(false);
      setManualText('');
    } catch (error) {
      alert("Erro ao extrair dados.");
    } finally {
      setIsProcessingText(false);
    }
  };

  const handleUpdateBuilding = async (updates: Partial<Building>) => {
    if (!selectedBuilding) return;
    setIsUpdatingBuilding(true);
    try {
      const buildingRef = doc(db, 'buildings', selectedBuilding.id!);
      await updateDoc(buildingRef, updates);
      const updatedBuilding = { ...selectedBuilding, ...updates };
      setSelectedBuilding(updatedBuilding);
      setBuildings(prev => prev.map(b => b.id === updatedBuilding.id ? updatedBuilding : b));
    } catch (error) {
      alert("Erro ao atualizar o prédio.");
    } finally {
      setIsUpdatingBuilding(false);
    }
  };

  const handleSaveBuildingEdit = async () => {
    if (!selectedBuilding || !editBuildingForm.buildingNumber.trim() || !editBuildingForm.address.trim()) {
      alert("Número e endereço são obrigatórios.");
      return;
    }
    await handleUpdateBuilding(editBuildingForm);
    setShowEditBuildingModal(false);
  };

  const handleAddApartment = async () => {
    if (!selectedBuilding || !newAptName.trim()) return;
    if (selectedBuilding.apartments.includes(newAptName.trim())) {
      alert("Este apartamento já existe.");
      return;
    }
    const updatedApartments = [...selectedBuilding.apartments, newAptName.trim()];
    const currentCount = parseInt(selectedBuilding.apartmentsCount || '0');
    const newCount = Math.max(currentCount, updatedApartments.length).toString();
    await handleUpdateBuilding({ apartments: updatedApartments, apartmentsCount: newCount });
    setNewAptName('');
    setShowAddAptModal(false);
  };

  const handleFacadeUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedBuilding) return;
    setIsUpdatingBuilding(true);
    try {
      const base64 = await compressImage(file);
      setCropImageBase64(`data:image/jpeg;base64,${base64}`);
      setCrop(undefined);
      setShowCropModal(true);
      if (facadeInputRef.current) facadeInputRef.current.value = '';
    } catch (error) {
      alert("Erro ao carregar imagem.");
    } finally {
      setIsUpdatingBuilding(false);
    }
  };

  const applyCrop = async () => {
    if (!imgRef.current || !selectedBuilding || !cropImageBase64) return;
    setIsUpdatingBuilding(true);
    setShowCropModal(false);
    try {
      if (!completedCrop || completedCrop.width === 0) {
        await handleUpdateBuilding({ facadeImageUrl: cropImageBase64 });
      } else {
        const canvas = document.createElement('canvas');
        const scaleX = imgRef.naturalWidth / imgRef.current.width;
        const scaleY = imgRef.naturalHeight / imgRef.current.height;
        canvas.width = completedCrop.width;
        canvas.height = completedCrop.height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(imgRef.current, completedCrop.x * scaleX, completedCrop.y * scaleY, completedCrop.width * scaleX, completedCrop.height * scaleY, 0, 0, completedCrop.width, completedCrop.height);
          canvas.toDataURL('image/jpeg', 0.85)
          await handleUpdateBuilding({ facadeImageUrl: finalBase64 });
        }
      }
    } catch (error) {
      alert("Erro: " + (error as Error).message);
    } finally {
       setIsUpdatingBuilding(false);
       setCropImageBase64('');
    }
  };

  const handleVerifyPasswordAndDownload = async () => {
    const REPORT_PASSWORD = import.meta.env.VITE_REPORT_PASSWORD || '8318';
    if (reportPassword !== REPORT_PASSWORD) {
      alert("Senha incorreta!");
      return;
    }
    setShowPasswordModal(false);
    setReportPassword('');
    try {
      const total = buildings.length;
      const completed = buildings.filter(b => b.isCompleted && b.apartments.length > 0).length;
      const notWorked = buildings.filter(b => !b.visitCount || b.visitCount === 0).length;
      const started = buildings.filter(b => (b.visitCount ?? 0) > 0 && !b.isCompleted).length;

      const reportContent = `RELATÓRIO RESUMIDO\nTotal: ${total}\nConcluídos: ${completed}\nIniciados: ${started}\nNão Trabalhados: ${notWorked}`;
      const blob = new Blob([reportContent], { type: 'text/plain;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `Resumo_Predios_${formatDate(new Date()).replace(/\//g, '-')}.txt`;
      link.click();
    } catch (error) {
      alert("Erro ao gerar relatório.");
    }
  };

  const syncAllBuildingStats = async () => {
    if (buildings.length === 0) return;
    setIsSyncingStats(true);
    try {
      await Promise.all(buildings.map(async (b) => {
        const visitsSnap = await getDocs(collection(db, `buildings/${b.id}/visits`));
        const visitsData = visitsSnap.docs.map(d => d.data());
        const visitedApts = new Set(visitsData.map(v => v.apartment));
        const isCompleted = b.apartments && b.apartments.length > 0 && b.apartments.every(apt => visitedApts.has(apt));
        
        if (b.visitCount !== visitsSnap.size || b.isCompleted !== isCompleted) {
          await updateDoc(doc(db, 'buildings', b.id), {
            visitCount: visitsSnap.size,
            isCompleted: isCompleted
          });
        }
      }));
      alert("Sincronizado!");
    } catch (error) {
      alert("Erro no sync.");
    } finally {
      setIsSyncingStats(false);
    }
  };

  const handleSaveVisit = async () => {
    if (!selectedBuilding || !activeApartment) return;
    setIsSavingVisit(true);
    try {
      const visitData = {
        buildingId: selectedBuilding.id,
        apartment: activeApartment,
        date: editingVisitId ? visits.find(v => v.id === editingVisitId)?.date : serverTimestamp(),
        contacted: visitContacted,
        notes: visitNotes,
        updatedAt: serverTimestamp()
      };
      if (editingVisitId) {
        await updateDoc(doc(db, `buildings/${selectedBuilding.id}/visits`, editingVisitId), visitData);
      } else {
        await addDoc(collection(db, `buildings/${selectedBuilding.id}/visits`), visitData);
        await updateDoc(doc(db, 'buildings', selectedBuilding.id), { visitCount: increment(1), lastVisitDate: serverTimestamp() });
      }
      setShowVisitModal(false);
      setVisitNotes('');
    } catch (error) {
      alert("Erro ao salvar visita.");
    } finally {
      setIsSavingVisit(false);
    }
  };

  const handleDeleteVisit = async (visitId: string, skipConfirm = false) => {
    if (!selectedBuilding) return;
    if (!skipConfirm) { setItemToDelete({ type: 'visit', id: visitId }); return; }
    setIsSavingVisit(true);
    try {
      await deleteDoc(doc(db, `buildings/${selectedBuilding.id}/visits`, visitId));
      await updateDoc(doc(db, 'buildings', selectedBuilding.id), { visitCount: increment(-1) });
      setShowVisitModal(false);
    } catch (error) { alert("Erro ao excluir."); } finally { setIsSavingVisit(false); }
  };

  const handleDeleteAllAptVisits = async (aptNumber: string, skipConfirm = false) => {
    if (!selectedBuilding) return;
    if (!skipConfirm) { setItemToDelete({ type: 'apartment', id: aptNumber }); return; }
    setIsSavingVisit(true);
    try {
      const aptVisits = visits.filter(v => v.apartment === aptNumber);
      const batch = writeBatch(db);
      aptVisits.forEach(v => batch.delete(doc(db, `buildings/${selectedBuilding.id}/visits`, v.id)));
      await batch.commit();
      await updateDoc(doc(db, 'buildings', selectedBuilding.id), { visitCount: increment(-aptVisits.length) });
    } catch (error) { alert("Erro ao limpar registros."); } finally { setIsSavingVisit(false); }
  };

  const handleDeleteBuilding = async (buildingId: string, skipConfirm = false) => {
    if (!skipConfirm) { setItemToDelete({ type: 'building', id: buildingId }); return; }
    setIsUpdatingBuilding(true);
    try {
      const visitsSnap = await getDocs(collection(db, `buildings/${buildingId}/visits`));
      const batch = writeBatch(db);
      visitsSnap.forEach((v) => batch.delete(v.ref));
      batch.delete(doc(db, 'buildings', buildingId));
      await batch.commit();
      setView('list'); setSelectedBuilding(null);
    } catch (error) { alert("Erro ao excluir prédio."); } finally { setIsUpdatingBuilding(false); }
  };

  const openInMaps = (address: string) => {
    const encoded = encodeURIComponent(address);
    window.open(`https://www.google.com/maps/search/?api=1&query=${encoded}`, '_blank');
  };

  const stats = {
    total: buildings.length,
    started: buildings.filter(b => (b.visitCount || 0) > 0 && !b.isCompleted).length,
    completed: buildings.filter(b => b.isCompleted && b.apartments && b.apartments.length > 0).length,
    pending: buildings.filter(b => (b.visitCount || 0) === 0 && !b.isCompleted).length
  };

  const filteredBuildings = buildings.filter(b => {
    const totalApts = b.apartments?.length || 0;
    const visitsDone = b.visitCount || 0;
    const isActuallyCompleted = b.isCompleted && totalApts > 0;

    if (activeFilter === 'started' && (visitsDone === 0 || isActuallyCompleted)) return false;
    if (activeFilter === 'pending' && visitsDone > 0) return false;
    if (activeFilter === 'completed' && !isActuallyCompleted) return false;

    if (!searchTerm.trim()) return true;
    const term = searchTerm.trim().toLowerCase();
    
    // Lógica da Lupinha Blindada: Só busca no número (ícone azul)
    return b.buildingNumber.toLowerCase() === term;
  });

  if (isLoading) return <div className="flex items-center justify-center h-screen bg-slate-50"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;

  return (
    <div className="min-h-screen bg-slate-100 pb-20 font-sans">
      <header className="sticky top-0 z-30 bg-white border-b px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          {view !== 'list' && (
            <button onClick={() => setView('list')} className="p-2 -ml-2 text-slate-500 hover:bg-slate-50 rounded-lg">
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
          <div className="flex items-center gap-3">
             <div className="w-10 h-10 bg-slate-900 rounded-xl flex items-center justify-center text-white"><Building2 className="w-6 h-6" /></div>
             <div>
                <h1 className="font-bold text-lg text-slate-900">{view === 'list' ? 'Testemunhos nos Prédios' : selectedBuilding?.name || 'Detalhes'}</h1>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Meus Prédios e Territórios</p>
             </div>
          </div>
        </div>
      </header>

      <main className="max-w-xl mx-auto p-4">
        {view === 'list' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center px-1">
               <h2 className="text-xs font-black uppercase tracking-[0.2em] text-slate-400">Prédios ({filteredBuildings.length})</h2>
               <button onClick={() => setShowPasswordModal(true)} className="flex items-center gap-2 text-xs font-bold text-blue-600"><FileDown className="w-4 h-4" /> Relatório</button>
            </div>

            <div className="relative group">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input type="text" placeholder="Buscar prédio..." className="w-full pl-11 pr-4 py-3 bg-white border rounded-xl text-sm focus:ring-4 focus:ring-blue-500/10 outline-none" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
            </div>

            <div className="space-y-2">
              <div className="flex justify-between items-center px-1">
                 <h3 className="text-[10px] font-bold uppercase text-slate-400">Resumo do Trabalho</h3>
                 <button onClick={syncAllBuildingStats} disabled={isSyncingStats} className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 hover:text-blue-600"><RefreshCw className={cn("w-3 h-3", isSyncingStats && "animate-spin")} /> Sincronizar</button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button onClick={() => setActiveFilter('all')} className={cn("p-4 rounded-3xl border", activeFilter === 'all' ? "bg-slate-900 text-white" : "bg-white text-slate-900")}>
                  <span className="block text-2xl font-black">{stats.total}</span>
                  <span className="text-[8px] font-bold uppercase opacity-60">Total</span>
                </button>
                <button onClick={() => setActiveFilter('started')} className={cn("p-4 rounded-3xl border", activeFilter === 'started' ? "bg-blue-600 text-white" : "bg-blue-50 text-blue-700")}>
                  <span className="block text-2xl font-black">{stats.started}</span>
                  <span className="text-[8px] font-bold uppercase opacity-60">Iniciados</span>
                </button>
                <button onClick={() => setActiveFilter('completed')} className={cn("p-4 rounded-3xl border", activeFilter === 'completed' ? "bg-emerald-600 text-white" : "bg-emerald-50 text-emerald-700")}>
                  <span className="block text-2xl font-black">{stats.completed}</span>
                  <span className="text-[8px] font-bold uppercase opacity-60">Concluídos</span>
                </button>
                <button onClick={() => setActiveFilter('pending')} className={cn("p-4 rounded-3xl border", activeFilter === 'pending' ? "bg-amber-500 text-white" : "bg-white text-slate-500")}>
                  <span className="block text-2xl font-black">{stats.pending}</span>
                  <span className="text-[8px] font-bold uppercase opacity-60">Pendente</span>
                </button>
              </div>
            </div>

            <div className="grid gap-3">
              {filteredBuildings.map(b => (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} key={b.id} onClick={() => { setSelectedBuilding(b); setView('building'); }} className="bg-white p-4 rounded-2xl border flex items-center justify-between cursor-pointer hover:border-blue-200 shadow-sm transition-all group">
                  <div className="flex-1 min-w-0 pr-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="px-3 py-1 bg-blue-600 text-white text-[10px] rounded-lg font-black uppercase">Prédio: {b.buildingNumber}</span>
                      {b.isCompleted && b.apartments.length > 0 && <span className="px-2 py-1 bg-emerald-100 text-emerald-700 text-[10px] rounded-lg font-black uppercase flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Concluído</span>}
                    </div>
                    <h3 className="font-bold text-slate-900 truncate group-hover:text-blue-600 transition-colors">{b.name || 'Sem nome'}</h3>
                    <p className="text-xs text-slate-500 truncate mt-1 flex items-center gap-1"><MapPin className="w-3 h-3" /> {b.address}</p>
                  </div>
                  <ChevronRight className="w-5 h-5 text-slate-300" />
                </motion.div>
              ))}
            </div>
          </div>
        )}

        {view === 'building' && selectedBuilding && (
          <div className="space-y-6 pb-24">
            <div className="bg-white rounded-3xl border overflow-hidden shadow-xl">
              <div onClick={() => !selectedBuilding.facadeImageUrl && facadeInputRef.current?.click()} className="h-24 bg-slate-100 relative cursor-pointer">
                {selectedBuilding.facadeImageUrl ? <img src={selectedBuilding.facadeImageUrl} className="w-full h-full object-cover" /> : <div className="w-full h-full flex flex-col items-center justify-center text-slate-400 gap-2"><ImageIcon className="w-8 h-8 opacity-20" /><span className="text-[10px] font-bold uppercase opacity-50">Foto</span></div>}
                {isUpdatingBuilding && <div className="absolute inset-0 bg-white/60 flex items-center justify-center"><Loader2 className="animate-spin text-blue-600" /></div>}
                {selectedBuilding.isCompleted && selectedBuilding.apartments.length > 0 && <div className="absolute top-4 left-4"><span className="px-3 py-1.5 bg-emerald-500 text-white text-[10px] font-black uppercase rounded-full shadow-lg flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5" /> Concluído</span></div>}
              </div>
              <div className="bg-slate-900 px-6 py-4 flex items-center justify-between">
                 <div className="text-white"><p className="text-[9px] font-bold text-slate-500 uppercase">Prédio</p><p className="font-black text-xl">{selectedBuilding.buildingNumber}</p></div>
                 <div className="flex gap-2">
                   <button onClick={() => { setEditBuildingForm({ name: selectedBuilding.name || '', buildingNumber: selectedBuilding.buildingNumber || '', address: selectedBuilding.address || '', apartmentsCount: selectedBuilding.apartmentsCount || '' }); setShowEditBuildingModal(true); }} className="p-2 bg-blue-500/20 text-blue-400 rounded-lg"><Edit className="w-4 h-4" /></button>
                   <button onClick={() => setItemToDelete({ type: 'building', id: selectedBuilding.id! })} className="p-2 bg-red-500/20 text-red-400 rounded-lg"><Trash2 className="w-4 h-4" /></button>
                   <button onClick={() => openInMaps(selectedBuilding.address)} className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white text-xs font-bold rounded-lg shadow-blue-500/20"><Navigation className="w-4 h-4" /> GPS</button>
                 </div>
              </div>
              <div className="p-6">
                 <p className="text-slate-900 font-bold text-lg leading-tight">{selectedBuilding.address}</p>
                 {selectedBuilding.name && <p className="text-blue-600 font-medium text-sm mt-1">{selectedBuilding.name}</p>}
              </div>{selectedBuilding.observations && <div className="px-6 py-3 bg-amber-50 border-t border-amber-100"><p className="text-xs font-bold uppercase tracking-widest text-amber-600 mb-1">Observações</p><p className="text-sm text-amber-900 font-medium">{selectedBuilding.observations}</p></div>}
              <div className="grid grid-cols-3 divide-x divide-slate-100 min-h-[100px]">
                <div className="p-4 flex flex-col justify-center">
                   <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400 mb-3">Correio</p>
                   <div className="flex gap-4">
                      <button onClick={() => handleUpdateBuilding({ mailbox: 'Individual' })} className="flex items-center gap-1.5 text-[10px] font-bold text-slate-600 group">
                        <div className={cn("w-2.5 h-2.5 rounded-full ring-2 ring-offset-2 transition-all", selectedBuilding.mailbox === 'Individual' ? 'bg-blue-500 ring-blue-500' : 'bg-white ring-slate-200 group-hover:ring-slate-400')} />
                        IND
                      </button>
                      <button onClick={() => handleUpdateBuilding({ mailbox: 'Coletiva' })} className="flex items-center gap-1.5 text-[10px] font-bold text-slate-600 group">
                        <div className={cn("w-2.5 h-2.5 rounded-full ring-2 ring-offset-2 transition-all", selectedBuilding.mailbox === 'Coletiva' ? 'bg-slate-900 ring-slate-900' : 'bg-white ring-slate-200 group-hover:ring-slate-400')} />
                        COL
                      </button>
                   </div>
                </div>
                <div className="p-4 flex flex-col justify-center">
                   <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400 mb-3">Interfone</p>
                   <div className="flex gap-4">
                      <button onClick={() => handleUpdateBuilding({ intercom: 'Sim' })} className="flex items-center gap-1.5 text-[10px] font-bold text-slate-600 group">
                        <div className={cn("w-2.5 h-2.5 rounded-full ring-2 ring-offset-2 transition-all", selectedBuilding.intercom === 'Sim' ? 'bg-blue-500 ring-blue-500' : 'bg-white ring-slate-200 group-hover:ring-slate-400')} />
                        SIM
                      </button>
                      <button onClick={() => handleUpdateBuilding({ intercom: 'Não' })} className="flex items-center gap-1.5 text-[10px] font-bold text-slate-600 group">
                        <div className={cn("w-2.5 h-2.5 rounded-full ring-2 ring-offset-2 transition-all", selectedBuilding.intercom === 'Não' ? 'bg-red-500 ring-red-500' : 'bg-white ring-slate-200 group-hover:ring-slate-400')} />
                        NÃO
                      </button>
                   </div>
                </div>
                <div className="p-4 flex flex-col justify-center text-center">
                   <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400 mb-1">Apartamentos</p>
                   <p className="text-3xl font-black text-slate-900 italic tracking-tighter">{selectedBuilding.apartmentsCount || '?'}</p>
                </div>
              </div>
            </div>

            <div className="bg-slate-900 rounded-3xl p-6 text-white shadow-xl relative overflow-hidden text-center">
                <h4 className="text-xs font-bold opacity-50 uppercase mb-6">Cobertura</h4>
                <div className="flex justify-between relative z-10">
                  <div><span className="block text-3xl font-black italic">{new Set(visits.map(v => v.apartment)).size}</span><span className="text-[8px] font-bold opacity-60">VISITADOS</span></div>
                  <div className="w-px h-10 bg-white/10" />
                  <div><span className="block text-3xl font-black italic">{Math.max(0, parseInt(selectedBuilding.apartmentsCount || '0') - new Set(visits.map(v => v.apartment)).size)}</span><span className="text-[8px] font-bold opacity-60">FALTAM</span></div>
                  <div className="w-px h-10 bg-white/10" />
                  <div><span className="block text-3xl font-black italic text-blue-400">{selectedBuilding.apartmentsCount && parseInt(selectedBuilding.apartmentsCount) > 0 ? Math.round((new Set(visits.map(v => v.apartment)).size / parseInt(selectedBuilding.apartmentsCount)) * 100) : 0}%</span><span className="text-[8px] font-bold opacity-60">ALCANCE</span></div>
                </div>
            </div>

            <div className="space-y-6">
              <h4 className="font-bold text-slate-900 text-sm flex items-center gap-2 px-1"><span className="w-1 h-4 bg-blue-600 rounded-full" /> Registrar Visita</h4>
              <div className="grid grid-cols-4 gap-3">
                {selectedBuilding.apartments.map(apt => {
                  const lastVisit = visits.find(v => v.apartment === apt);
                  return (
                    <button key={apt} onClick={() => { setActiveApartment(apt); if (lastVisit) { setVisitContacted(lastVisit.contacted); setVisitNotes(lastVisit.notes || ''); setEditingVisitId(lastVisit.id); } else { setVisitContacted(true); setVisitNotes(''); setEditingVisitId(null); } setShowVisitModal(true); }} className={cn("p-4 py-6 rounded-2xl border-2 flex flex-col items-center transition-all min-h-[100px]", lastVisit ? (lastVisit.contacted ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-700') : 'bg-white border-white text-slate-600 shadow-sm')}>
                      <span className="text-xl font-black tracking-tighter">{apt}</span>
                      {lastVisit && <span className="text-[8px] font-black uppercase mt-2">{lastVisit.contacted ? 'SIM' : 'NÃO'}</span>}
                    </button>
                  );
                })}
                <button onClick={() => setShowAddAptModal(true)} className="p-4 py-6 rounded-2xl border-2 border-dashed border-slate-200 flex flex-col items-center text-slate-400 hover:bg-blue-50 transition-all"><Plus className="w-6 h-6 mb-1" /><span className="text-[10px] font-black uppercase">Novo</span></button>
              </div>
            </div>

            <div className="space-y-4">
               <h4 className="font-bold text-slate-900 text-sm flex items-center gap-2 px-1"><span className="w-1 h-4 bg-slate-900 rounded-full" /> Histórico de Visitas</h4>
               <div className="bg-white rounded-3xl border overflow-hidden shadow-sm">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="p-4 font-bold text-slate-400 uppercase">Apto</th>
                        <th className="p-4 font-bold text-slate-400 uppercase">Data</th>
                        <th className="p-4 font-bold text-slate-400 uppercase text-center">Status</th>
                        <th className="p-4 font-bold text-slate-400 uppercase text-right">Ação</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {visits.length === 0 ? <tr><td colSpan={4} className="p-8 text-center text-slate-300 italic">Nenhuma visita ainda</td></tr> : visits.map(v => (
                        <tr key={v.id} className="hover:bg-slate-50">
                          <td className="p-4 font-black text-slate-900">
                             <div className="flex items-center gap-2">
                               {v.apartment}
                               <button onClick={() => handleDeleteAllAptVisits(v.apartment)} className="p-1 text-red-400"><Trash2 className="w-3 h-3"/></button>
                             </div>
                          </td>
                          <td className="p-4 text-slate-500">{formatDate(v.date?.toDate() || new Date())}</td>
                          <td className="p-4 text-center">
                            {v.contacted ? <CheckCircle2 className="w-4 h-4 text-green-500 mx-auto"/> : <XCircle className="w-4 h-4 text-red-500 mx-auto"/>}
                          </td>
                          <td className="p-4 text-right">
                             <div className="flex justify-end gap-1">
                               <button onClick={() => { setActiveApartment(v.apartment); setVisitContacted(v.contacted); setVisitNotes(v.notes || ''); setEditingVisitId(v.id); setShowVisitModal(true); }} className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg"><Edit className="w-4 h-4"/></button>
                               <button onClick={() => handleDeleteVisit(v.id)} className="p-2 text-red-500 hover:bg-red-50 rounded-lg"><Trash2 className="w-4 h-4"/></button>
                             </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
               </div>
            </div>
          </div>
        )}
      </main>

      <div className="fixed bottom-6 right-6 z-40">
        <button onClick={() => setShowManualModal(true)} className="bg-blue-600 text-white w-16 h-16 rounded-full shadow-2xl flex items-center justify-center hover:scale-110 active:scale-95 transition-all"><Plus className="w-8 h-8" /></button>
      </div>

      <input type="file" accept="image/*" className="hidden" ref={facadeInputRef} onChange={handleFacadeUpload} />

      <AnimatePresence>
        {showManualModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowManualModal(false)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" />
            <motion.div initial={{ y: 50, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="relative bg-white w-full max-w-lg rounded-[2.5rem] p-8 shadow-2xl">
               <h3 className="text-2xl font-black text-slate-900 mb-2">Novo Prédio</h3>
               <p className="text-xs text-slate-400 uppercase tracking-widest font-bold mb-6">Cadastro Rápido</p>
               <textarea value={manualText} onChange={(e) => setManualText(e.target.value)} placeholder="Ex: Rua Central 100, 4 aptos: 101, 102, 201, 202..." className="w-full p-5 bg-slate-50 border-none rounded-3xl text-sm min-h-[150px] outline-none" />
               <button onClick={handleTextUpload} disabled={isProcessingText || !manualText.trim()} className="w-full py-5 bg-blue-600 text-white rounded-[2rem] font-black text-lg mt-6 shadow-xl shadow-blue-500/20 disabled:opacity-50">{isProcessingText ? <Loader2 className="animate-spin mx-auto" /> : "Cadastrar"}</button>
            </motion.div>
          </div>
        )}

        {showVisitModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div onClick={() => setShowVisitModal(false)} className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" />
            <motion.div className="relative bg-white w-full max-w-lg rounded-[2.5rem] p-8 shadow-2xl">
               <h3 className="text-2xl font-black mb-6">Apto {activeApartment}</h3>
               <p className="text-lg font-black text-slate-700 text-center mb-2">Alguém atendeu o interfone?</p>
              <div className="grid grid-cols-2 gap-3 mb-6">
                  <button onClick={() => setVisitContacted(true)} className={cn("py-4 rounded-2xl font-black transition-all", visitContacted ? 'bg-green-100 text-green-700 ring-2 ring-green-500' : 'bg-slate-50 text-slate-400')}>SIM</button>
                  <button onClick={() => setVisitContacted(false)} className={cn("py-4 rounded-2xl font-black transition-all", !visitContacted ? 'bg-red-100 text-red-700 ring-2 ring-red-500' : 'bg-slate-50 text-slate-400')}>NÃO</button>
               </div>
               {visitNotes && (
                  <div className="w-full p-4 bg-amber-400 rounded-2xl border-2 border-amber-500">
                    <p className="text-xs font-black uppercase tracking-widest text-amber-900 mb-1">⚠️ NOTA IMPORTANTE</p>
                    <p className="text-sm font-bold text-amber-900">{visitNotes}</p>
                  </div>
                )}
                <button onClick={() => { const s = prompt('Senha:'); if (s !== null && s === '8318') { const n = prompt('Nota:'); if (n !== null) setVisitNotes(n); } else if (s !== null) alert('Incorreta!'); }} className="w-full p-3 bg-slate-50 border border-slate-200 rounded-2xl text-xs font-medium text-slate-400 text-center hover:bg-slate-100 transition-all">
                  🔒 nota
                </button>
               <button onClick={handleSaveVisit} disabled={isSavingVisit} className="w-full py-5 bg-slate-900 text-white rounded-[2rem] font-black shadow-xl">{isSavingVisit ? <Loader2 className="animate-spin mx-auto" /> : "Salvar Visita"}</button>
            </motion.div>
          </div>
        )}

        {showPasswordModal && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <div onClick={() => setShowPasswordModal(false)} className="absolute inset-0 bg-slate-900/60 backdrop-blur-md" />
            <motion.div className="relative bg-white w-full max-w-sm rounded-[2.5rem] p-8 shadow-2xl">
              <h3 className="text-xl font-black text-center mb-6">Relatório</h3>
              <input type="password" value={reportPassword} onChange={(e) => setReportPassword(e.target.value)} placeholder="Senha" className="w-full p-5 bg-slate-50 rounded-2xl text-center text-2xl font-black outline-none mb-4" />
              <button onClick={handleVerifyPasswordAndDownload} className="w-full py-4 bg-slate-900 text-white rounded-2xl font-black shadow-lg">Confirmar</button>
            </motion.div>
          </div>
        )}

        {showCropModal && (
          <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-slate-900/90 backdrop-blur-md" />
            <motion.div className="relative bg-white w-full max-w-lg rounded-[2.5rem] p-6 shadow-2xl flex flex-col max-h-[90vh]">
              <div className="flex-1 overflow-auto bg-slate-100 rounded-2xl mb-4">
                <ReactCrop crop={crop} onChange={c => setCrop(c)} onComplete={c => setCompletedCrop(c)}>
                  <img ref={imgRef} src={cropImageBase64} className="max-h-[50vh] w-auto" />
                </ReactCrop>
              </div>
              <button onClick={applyCrop} className="w-full py-4 bg-blue-600 text-white rounded-2xl font-black uppercase shadow-lg">Aplicar Recorte</button>
            </motion.div>
          </div>
        )}

        {showEditBuildingModal && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <div onClick={() => setShowEditBuildingModal(false)} className="absolute inset-0 bg-slate-900/60 backdrop-blur-md" />
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="relative bg-white w-full max-w-sm rounded-[2.5rem] p-8 shadow-2xl">
              <h3 className="text-xl font-black text-slate-900 mb-6">Editar Prédio</h3>
              <div className="space-y-4">
                <input type="text" value={editBuildingForm.buildingNumber} onChange={(e) => setEditBuildingForm({...editBuildingForm, buildingNumber: e.target.value})} placeholder="Número" className="w-full p-4 bg-slate-50 rounded-2xl font-bold outline-none"/>
                <input type="text" value={editBuildingForm.name} onChange={(e) => setEditBuildingForm({...editBuildingForm, name: e.target.value})} placeholder="Nome (Opcional)" className="w-full p-4 bg-slate-50 rounded-2xl font-bold outline-none"/>
                <textarea value={editBuildingForm.address} onChange={(e) => setEditBuildingForm({...editBuildingForm, address: e.target.value})} placeholder="Endereço" className="w-full p-4 bg-slate-50 rounded-2xl font-bold outline-none"/>
                <input type="number" value={editBuildingForm.apartmentsCount} onChange={(e) => setEditBuildingForm({...editBuildingForm, apartmentsCount: e.target.value})} placeholder="Qtd de Aptos" className="w-full p-4 bg-slate-50 rounded-2xl font-bold outline-none"/>
                <textarea value={editBuildingForm.observations} onChange={(e) => setEditBuildingForm({...editBuildingForm, observations: e.target.value})} placeholder="Observações (Opcional)" className="w-full p-4 bg-slate-50 rounded-2xl font-bold outline-none min-h-[100px]"/>
              </div>
              <button onClick={handleSaveBuildingEdit} className="w-full py-4 bg-slate-900 text-white rounded-2xl font-black mt-6">Salvar</button>
            </motion.div>
          </div>
        )}
        {showAddAptModal && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <div onClick={() => setShowAddAptModal(false)} className="absolute inset-0 bg-slate-900/60 backdrop-blur-md" />
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="relative bg-white w-full max-w-sm rounded-[2.5rem] p-8 shadow-2xl">
              <h3 className="text-xl font-black text-slate-900 mb-6">Adicionar Apartamento</h3>
              <input
                type="text"
                value={newAptName}
                onChange={(e) => setNewAptName(e.target.value)}
                placeholder="Ex: 101, 202..."
                className="w-full p-4 bg-slate-50 rounded-2xl font-bold outline-none"
                onKeyDown={(e) => e.key === 'Enter' && handleAddApartment()}
              />
              <button onClick={handleAddApartment} disabled={isUpdatingBuilding || !newAptName.trim()} className="w-full py-4 bg-slate-900 text-white rounded-2xl font-black mt-6 disabled:opacity-50">
                {isUpdatingBuilding ? <Loader2 className="animate-spin mx-auto" /> : "Adicionar"}
              </button>
            </motion.div>
          </div>
        )}

        {itemToDelete && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <div onClick={() => setItemToDelete(null)} className="absolute inset-0 bg-slate-900/60" />
            <motion.div className="relative bg-white w-full max-w-sm rounded-[2.5rem] p-8 text-center shadow-2xl">
              <Trash2 className="w-12 h-12 text-red-500 mx-auto mb-4" />
              <h3 className="text-xl font-black">Excluir?</h3>
              <p className="text-sm text-slate-500 my-4">Ação permanente.</p>
              <div className="flex flex-col gap-3">
                <button onClick={() => { if (itemToDelete.type === 'building') handleDeleteBuilding(itemToDelete.id, true); if(itemToDelete.type === 'visit') handleDeleteVisit(itemToDelete.id, true); if(itemToDelete.type === 'apartment') handleDeleteAllAptVisits(itemToDelete.id, true); setItemToDelete(null); }} className="w-full py-4 bg-red-500 text-white rounded-2xl font-black shadow-red-500/30 shadow-lg">SIM, APAGAR</button>
                <button onClick={() => setItemToDelete(null)} className="w-full py-2 text-slate-400 font-bold uppercase text-[10px]">Cancelar</button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
