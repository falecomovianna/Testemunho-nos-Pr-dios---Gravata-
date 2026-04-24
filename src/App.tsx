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
        const MAX_WIDTH = 1200;
        const scaleSize = MAX_WIDTH / img.width;
        canvas.width = MAX_WIDTH;
        canvas.height = img.height * scaleSize;

        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);

        // Quality 0.7 is usually enough for OCR
        const base64 = canvas.toDataURL('image/jpeg', 0.7);
        resolve(base64.split(',')[1]);
      };
    };
  });
}

async function cropImageBase64(base64Data: string, bbox: {ymin: number, xmin: number, ymax: number, xmax: number}): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${base64Data}`;
    img.onload = () => {
      // bbox is normalized 0.0 - 1.0
      // Calculate crop dimensions
      let sourceX = img.width * bbox.xmin;
      let sourceY = img.height * bbox.ymin;
      let sourceW = img.width * (bbox.xmax - bbox.xmin);
      let sourceH = img.height * (bbox.ymax - bbox.ymin);

      // Validate bounds to prevent canvas errors
      if (sourceW <= 0 || sourceH <= 0) resolve(base64Data);

      const canvas = document.createElement('canvas');
      canvas.width = sourceW;
      canvas.height = sourceH;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(img, sourceX, sourceY, sourceW, sourceH, 0, 0, sourceW, sourceH);

      const croppedBase64 = canvas.toDataURL('image/jpeg', 0.85);
      resolve(croppedBase64.split(',')[1]);
    };
    img.onerror = () => resolve(base64Data);
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
  // Modals & Popups
  const [showManualModal, setShowManualModal] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showAddAptModal, setShowAddAptModal] = useState(false);
  const [itemToDelete, setItemToDelete] = useState<{type: 'visit' | 'apartment' | 'building', id: string} | null>(null);
  
  const [showEditBuildingModal, setShowEditBuildingModal] = useState(false);
  const [editBuildingForm, setEditBuildingForm] = useState<{name: string, buildingNumber: string, address: string, apartmentsCount: string}>({name: '', buildingNumber: '', address: '', apartmentsCount: ''});

  const [newAptName, setNewAptName] = useState('');
  const [reportPassword, setReportPassword] = useState('');
  const [isUpdatingBuilding, setIsUpdatingBuilding] = useState(false);
  const [view, setView] = useState<'list' | 'building' | 'add'>('list');
  const facadeInputRef = useRef<HTMLInputElement>(null);

  // Visit Modal State
  const [showVisitModal, setShowVisitModal] = useState(false);
  const [activeApartment, setActiveApartment] = useState<string | null>(null);
  const [visitContacted, setVisitContacted] = useState(true);
  const [visitNotes, setVisitNotes] = useState('');
  const [editingVisitId, setEditingVisitId] = useState<string | null>(null);
  const [isSavingVisit, setIsSavingVisit] = useState(false);
  const [isSyncingStats, setIsSyncingStats] = useState(false);

  // Visits state for the selected building
  const [visits, setVisits] = useState<Visit[]>([]);

  const [showLocationPrompt, setShowLocationPrompt] = useState(false);
  
  // Crop state
  const [showCropModal, setShowCropModal] = useState(false);
  const [cropImageBase64, setCropImageBase64] = useState<string>('');
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    // Check if geolocation permission is already granted or explicitly denied, if not, ask for it
    if ('permissions' in navigator) {
      navigator.permissions.query({ name: 'geolocation' }).then((result) => {
        if (result.state === 'prompt') {
          setShowLocationPrompt(true);
        } else if (result.state === 'granted') {
          navigator.geolocation.getCurrentPosition(()=>{}, ()=>{});
        }
      });
    } else {
       // fallback
       setShowLocationPrompt(true);
    }
  }, []);

  const requestLocation = () => {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        () => {
          setShowLocationPrompt(false);
          console.log('Localização permitida');
        },
        (err) => {
           console.log('Localização negada ou erro:', err);
           setShowLocationPrompt(false); 
        }
      );
    } else {
      setShowLocationPrompt(false);
    }
  };

  useEffect(() => {
    const q = query(
      collection(db, 'buildings')
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() } as Building))
        .sort((a: Building, b: Building) => {
          const numA = a.buildingNumber || "";
          const numB = b.buildingNumber || "";
          // Aplica ordem natural para números (entende que "2" vem antes de "10")
          return numA.localeCompare(numB, undefined, { numeric: true, sensitivity: 'base' });
        });
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

    const q = query(
      collection(db, `buildings/${buildingId}/visits`)
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() } as Visit))
        .sort((a: any, b: any) => {
          const dateA = a.date?.toDate?.() || new Date(a.date || 0);
          const dateB = b.date?.toDate?.() || new Date(b.date || 0);
          return dateB - dateA;
        });
      setVisits(data);

      // Auto-sync visit count and completion if it's missing or incorrect
      // Use snapshot values directly to avoid stale closure over selectedBuilding
      setBuildings(prevBuildings => {
        const currentBuilding = prevBuildings.find(b => b.id === buildingId);
        if (!currentBuilding) return prevBuildings;

        const visitedApts = new Set(data.map(v => v.apartment));
        const isCompleted = currentBuilding.apartments.every(apt => visitedApts.has(apt));

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
        createdAt: serverTimestamp()
      });
      
      const newBuilding = { 
        id: docRef.id, 
        ...extracted, 
        ownerId: 'team_public',
        createdAt: new Date()
      } as Building;

      setSelectedBuilding(newBuilding);
      setView('building');
      setShowManualModal(false);
      setManualText('');
    } catch (error) {
      console.error(error);
      alert("Erro ao extrair dados do texto. Tente descrever com mais detalhes.");
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
      
      // Update local state and the list seamlessly
      const updatedBuilding = { ...selectedBuilding, ...updates };
      setSelectedBuilding(updatedBuilding);
      setBuildings(prev => prev.map(b => b.id === updatedBuilding.id ? updatedBuilding : b));
    } catch (error) {
      console.error(error);
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
    
    // Check if apartment already exists
    if (selectedBuilding.apartments.includes(newAptName.trim())) {
      alert("Este apartamento já existe.");
      return;
    }

    const updatedApartments = [...selectedBuilding.apartments, newAptName.trim()];
    
    // Also update the apartment count if possible
    const currentCount = parseInt(selectedBuilding.apartmentsCount || '0');
    const newCount = Math.max(currentCount, updatedApartments.length).toString();

    await handleUpdateBuilding({ 
      apartments: updatedApartments,
      apartmentsCount: newCount
    });
    
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
      setCrop(undefined); // Reset crop state
      setShowCropModal(true);
      if (facadeInputRef.current) facadeInputRef.current.value = '';
    } catch (error) {
      console.error(error);
      alert("Erro ao preparar imagem para recorte.");
    } finally {
      setIsUpdatingBuilding(false);
    }
  };

  const applyCrop = async () => {
    if (!imgRef.current || !selectedBuilding || !cropImageBase64) return;
    
    // Se não tiver corte aplicado, envia a imagem inteira
    if (!completedCrop || completedCrop.width === 0 || completedCrop.height === 0) {
      setIsUpdatingBuilding(true);
      setShowCropModal(false);
      try {
        await handleUpdateBuilding({ facadeImageUrl: cropImageBase64 });
      } catch (e) {
        alert("Erro ao atualizar a foto.");
      } finally {
        setIsUpdatingBuilding(false);
      }
      return;
    }

    setIsUpdatingBuilding(true);
    setShowCropModal(false);

    try {
      const canvas = document.createElement('canvas');
      const scaleX = imgRef.current.naturalWidth / imgRef.current.width;
      const scaleY = imgRef.current.naturalHeight / imgRef.current.height;
      canvas.width = completedCrop.width;
      canvas.height = completedCrop.height;
      const ctx = canvas.getContext('2d');
      
      if (!ctx) return;

      // Desenhar o recorte da imagem original no novo canvas
      ctx.drawImage(
        imgRef.current,
        completedCrop.x * scaleX,
        completedCrop.y * scaleY,
        completedCrop.width * scaleX,
        completedCrop.height * scaleY,
        0,
        0,
        completedCrop.width,
        completedCrop.height
      );

      const finalBase64 = canvas.toDataURL('image/jpeg', 0.85);
      await handleUpdateBuilding({ facadeImageUrl: finalBase64 });
    } catch (error) {
       console.error("Erro ao aplicar recorte:", error);
       alert("Erro ao recortar imagem.");
    } finally {
       setIsUpdatingBuilding(false);
       setCropImageBase64('');
    }
  };

  const downloadReport = async () => {
    if (buildings.length === 0) return;
    setShowPasswordModal(true);
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
      const completed = buildings.filter(b => b.isCompleted).length;
      const notWorked = buildings.filter(b => !b.visitCount || b.visitCount === 0).length;
      const started = buildings.filter(b => (b.visitCount ?? 0) > 0 && !b.isCompleted).length;

      const reportContent = `RELATÓRIO RESUMIDO - TESTEMUNHOS NOS PRÉDIOS
Data: ${formatDate(new Date())}

---------------------------------------------------
RESUMO DO TERRITÓRIO
---------------------------------------------------
Total de Prédios:     ${total}
Concluídos:           ${completed}
Iniciados:            ${started}
Não Trabalhados:     ${notWorked}
---------------------------------------------------
`;
      
      const blob = new Blob([reportContent], { type: 'text/plain;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `Resumo_Predios_${formatDate(new Date()).replace(/\//g, '-')}.txt`;
      link.click();
    } catch (error) {
      console.error(error);
      alert("Erro ao gerar relatório.");
    }
  };

  const syncAllBuildingStats = async () => {
    if (buildings.length === 0) return;
    
    setIsSyncingStats(true);
    try {
      await Promise.all(buildings.map(async (b) => {
        const visitsSnap = await getDocs(collection(db, `buildings/${b.id}/visits`));
        const visits = visitsSnap.docs.map(d => d.data());
        const visitCount = visitsSnap.size;
        
        const visitedApts = new Set(visits.map(v => v.apartment));
        const isCompleted = b.apartments.every(apt => visitedApts.has(apt));
        
        // Update if either count or completion state is different
        if (b.visitCount !== visitCount || b.isCompleted !== isCompleted) {
          const buildingRef = doc(db, 'buildings', b.id);
          await updateDoc(buildingRef, {
            visitCount: visitCount,
            isCompleted: isCompleted,
            lastVisitDate: visits.length > 0 ? (visits.sort((a: any, b: any) => (b.date?.toDate?.() || 0) - (a.date?.toDate?.() || 0))[0]?.date) : null
          });
        }
      }));
      alert("Estatísticas sincronizadas com sucesso!");
    } catch (error) {
      console.error(error);
      alert("Erro ao sincronizar estatísticas.");
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
        updatedAt: serverTimestamp(),
        contacted: visitContacted,
        notes: visitNotes,
        visitorId: 'team_public',
        visitorEmail: 'equipe@publico'
      };

      if (editingVisitId) {
        const visitRef = doc(db, `buildings/${selectedBuilding.id}/visits`, editingVisitId);
        await updateDoc(visitRef, {
          contacted: visitContacted,
          notes: visitNotes,
          updatedAt: serverTimestamp()
        });
      } else {
        await addDoc(collection(db, `buildings/${selectedBuilding.id}/visits`), visitData);
        // Update building stats
        const buildingRef = doc(db, 'buildings', selectedBuilding.id);
        await updateDoc(buildingRef, {
          visitCount: increment(1),
          lastVisitDate: serverTimestamp()
        });
      }
      
      setShowVisitModal(false);
      setActiveApartment(null);
      setVisitNotes('');
      setEditingVisitId(null);
    } catch (error) {
      console.error(error);
      alert("Erro ao salvar visita.");
    } finally {
      setIsSavingVisit(false);
    }
  };

  const handleDeleteVisit = async (visitId: string, skipConfirm = false) => {
    if (!selectedBuilding) return;
    
    if (!skipConfirm) {
      setItemToDelete({ type: 'visit', id: visitId });
      return;
    }

    setIsSavingVisit(true);
    try {
      const visitRef = doc(db, `buildings/${selectedBuilding.id}/visits`, visitId);
      await deleteDoc(visitRef);

      // Decrement visitCount to keep stats in sync
      const buildingRef = doc(db, 'buildings', selectedBuilding.id);
      await updateDoc(buildingRef, {
        visitCount: increment(-1)
      });
      
      setShowVisitModal(false);
      setEditingVisitId(null);
      setVisitNotes('');
    } catch (error) {
      console.error(error);
      alert("Erro ao excluir registro.");
    } finally {
      setIsSavingVisit(false);
    }
  };

  const handleDeleteAllAptVisits = async (aptNumber: string, skipConfirm = false) => {
    if (!selectedBuilding) return;
    
    if (!skipConfirm) {
      setItemToDelete({ type: 'apartment', id: aptNumber });
      return;
    }

    setIsSavingVisit(true);
    try {
      const aptVisits = visits.filter(v => v.apartment === aptNumber);
      const batch = writeBatch(db);
      
      aptVisits.forEach(v => {
        const visitRef = doc(db, `buildings/${selectedBuilding.id}/visits`, v.id);
        batch.delete(visitRef);
      });

      await batch.commit();
      
      setShowVisitModal(false);
      setEditingVisitId(null);
      setVisitNotes('');
    } catch (error) {
      console.error(error);
      alert("Erro ao limpar registros.");
    } finally {
      setIsSavingVisit(false);
    }
  };

  const handleDeleteBuilding = async (buildingId: string, skipConfirm = false) => {
    if (!skipConfirm) {
      setItemToDelete({ type: 'building', id: buildingId });
      return;
    }

    setIsUpdatingBuilding(true);
    try {
      // Step 1: Query and delete all subcollection 'visits' items for this building
      const visitsRef = collection(db, `buildings/${buildingId}/visits`);
      const visitsSnap = await getDocs(visitsRef);
      
      if (!visitsSnap.empty) {
        const batch = writeBatch(db);
        visitsSnap.forEach((visitDoc) => {
          batch.delete(visitDoc.ref);
        });
        await batch.commit();
      }

      // Step 2: Delete the main building doc
      const buildingDocRef = doc(db, 'buildings', buildingId);
      await deleteDoc(buildingDocRef);

      setView('list');
      setSelectedBuilding(null);
    } catch (error) {
       console.error("Error deleting building and visits:", error);
       alert("Erro ao excluir o prédio.");
    } finally {
      setIsUpdatingBuilding(false);
    }
  };

  const openInMaps = (address: string) => {
    const encoded = encodeURIComponent(address);
    window.open(`https://www.google.com/maps/search/?api=1&query=${encoded}`, '_blank');
  };

  const filteredBuildings = buildings.filter(b => {
    // Apply status filter
    if (activeFilter === 'started' && (!b.visitCount || b.visitCount === 0)) return false;
    if (activeFilter === 'pending' && (b.visitCount && b.visitCount > 0)) return false;
    if (activeFilter === 'completed' && !b.isCompleted) return false;

    // Apply search filter
    if (!searchTerm.trim()) return true;
    const term = searchTerm.trim().toLowerCase();
    const isNumeric = /^\d+$/.test(term);
    const matchesNumber = isNumeric
      ? parseInt(b.buildingNumber, 10) === parseInt(term, 10) ||
        b.buildingNumber.toLowerCase().includes(term)
      : b.buildingNumber.toLowerCase().includes(term);
    const matchesAddress = b.address.toLowerCase().includes(term);
    const matchesName = b.name ? b.name.toLowerCase().includes(term) : false;
    return matchesNumber || matchesAddress || matchesName;
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-50">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 pb-20 font-sans selection:bg-blue-100 selection:text-blue-900">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          {view !== 'list' && (
            <button onClick={() => setView('list')} className="p-2 -ml-2 text-slate-500 hover:bg-slate-50 rounded-lg transition-colors">
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
          <div className="flex items-center gap-3">
             <div className="w-10 h-10 bg-slate-900 rounded-xl flex items-center justify-center text-white shadow-sm">
                <Building2 className="w-6 h-6" />
             </div>
             <div>
                <h1 className="font-bold text-lg text-slate-900 leading-tight">
                  {view === 'list' ? 'Testemunhos nos Prédios' : selectedBuilding?.name || 'Detalhes do Prédio'}
                </h1>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest leading-none mt-1">
                  {view === 'list' ? 'Meus Prédios e Territórios' : 'Gestão de Visitas e Cadastro'}
                </p>
             </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
           {/* Header Actions can go here if needed */}
        </div>
      </header>

      <main className="max-w-xl mx-auto p-4">
        {view === 'list' && (
          <div className="space-y-6">
            {/* Header / Report Button */}
            <div className="flex justify-between items-center px-1">
               <h2 className="text-xs font-black uppercase tracking-[0.2em] text-slate-400">
                 {activeFilter === 'all' ? 'Meus Prédios' : 
                  activeFilter === 'started' ? 'Prédios Iniciados' : 
                  activeFilter === 'completed' ? 'Prédios Concluídos' : 'Não Trabalhados'}
                 <span className="ml-2 text-slate-300">({filteredBuildings.length})</span>
               </h2>
               <button 
                  onClick={downloadReport}
                  className="flex items-center gap-2 text-xs font-bold text-blue-600 hover:text-blue-700 transition-colors"
                >
                  <FileDown className="w-4 h-4" />
                  Baixar Relatório
               </button>
            </div>

            {/* Search */}
            <div className="relative group">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-blue-500 transition-colors" />
              <input 
                type="text"
                placeholder="Buscar prédio ou endereço..."
                className="w-full pl-11 pr-4 py-3 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 transition-all shadow-sm"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>

            {/* Dashboard Stats */}
            <div className="space-y-2">
              <div className="flex justify-between items-center px-1">
                 <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Resumo do Trabalho</h3>
                 <button 
                  onClick={syncAllBuildingStats}
                  disabled={isSyncingStats}
                  className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 hover:text-blue-600 transition-colors disabled:opacity-50"
                 >
                   <RefreshCw className={cn("w-3 h-3", isSyncingStats && "animate-spin")} />
                   Sincronizar
                 </button>
              </div>
              <div className="grid grid-cols-2 gap-3">
              <button 
                onClick={() => setActiveFilter('all')}
                className={cn(
                  "p-4 rounded-3xl border transition-all flex flex-col items-center justify-center text-center active:scale-95",
                  activeFilter === 'all' 
                    ? "bg-slate-900 border-slate-900 text-white shadow-lg shadow-slate-900/20" 
                    : "bg-white border-slate-100 shadow-sm text-slate-900"
                )}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={cn("text-2xl font-black leading-none", activeFilter === 'all' ? "text-white" : "text-slate-900")}>
                    {buildings.length}
                  </span>
                </div>
                <span className={cn("text-[8px] font-bold uppercase tracking-widest", activeFilter === 'all' ? "text-white/60" : "text-slate-400")}>
                  Total Prédios
                </span>
              </button>

              <button 
                onClick={() => setActiveFilter('started')}
                className={cn(
                  "p-4 rounded-3xl border transition-all flex flex-col items-center justify-center text-center active:scale-95",
                  activeFilter === 'started' 
                    ? "bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-600/20" 
                    : "bg-blue-50 border-blue-100 shadow-sm text-blue-700"
                )}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={cn("text-2xl font-black leading-none", activeFilter === 'started' ? "text-white" : "text-blue-700")}>
                    {buildings.filter(b => (b.visitCount || 0) > 0).length}
                  </span>
                </div>
                <span className={cn("text-[8px] font-bold uppercase tracking-widest", activeFilter === 'started' ? "text-white/60" : "text-blue-600/60")}>
                  Iniciados
                </span>
              </button>

              <button 
                onClick={() => setActiveFilter('completed')}
                className={cn(
                  "p-4 rounded-3xl border transition-all flex flex-col items-center justify-center text-center active:scale-95",
                  activeFilter === 'completed' 
                    ? "bg-emerald-600 border-emerald-600 text-white shadow-lg shadow-emerald-600/20" 
                    : "bg-emerald-50 border-emerald-100 shadow-sm text-emerald-700"
                )}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={cn("text-2xl font-black leading-none", activeFilter === 'completed' ? "text-white" : "text-emerald-700")}>
                    {buildings.filter(b => b.isCompleted).length}
                  </span>
                </div>
                <span className={cn("text-[8px] font-bold uppercase tracking-widest", activeFilter === 'completed' ? "text-white/60" : "text-emerald-600/60")}>
                  Concluídos
                </span>
              </button>

              <button 
                onClick={() => setActiveFilter('pending')}
                className={cn(
                  "p-4 rounded-3xl border transition-all flex flex-col items-center justify-center text-center active:scale-95",
                  activeFilter === 'pending' 
                    ? "bg-amber-500 border-amber-500 text-white shadow-lg shadow-amber-500/20" 
                    : "bg-slate-50 border-slate-100 shadow-sm text-slate-500"
                )}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={cn("text-2xl font-black leading-none", activeFilter === 'pending' ? "text-white" : "text-slate-500")}>
                    {buildings.filter(b => (b.visitCount || 0) === 0).length}
                  </span>
                </div>
                <span className={cn("text-[8px] font-bold uppercase tracking-widest", activeFilter === 'pending' ? "text-white/60" : "text-slate-400")}>
                  Não trabalhado
                </span>
              </button>
            </div>
          </div>

            {/* List */}
            <div className="grid gap-3">
              {filteredBuildings.length === 0 ? (
                <div className="text-center py-16 bg-white rounded-3xl border border-dashed border-slate-200 mt-4">
                  <div className="bg-slate-50 w-16 h-16 rounded-3xl flex items-center justify-center mx-auto mb-4 border border-slate-100">
                    <Building2 className="w-8 h-8 text-slate-300" />
                  </div>
                  <p className="text-slate-400 font-medium">Nenhum prédio encontrado</p>
                </div>
              ) : (
                filteredBuildings.map(building => (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    key={building.id} 
                    onClick={() => {
                      setSelectedBuilding(building);
                      setView('building');
                    }}
                    className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md hover:border-blue-200 transition-all cursor-pointer flex items-center justify-between group"
                  >
                    <div className="flex-1 min-w-0 pr-4">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="px-3 py-1 bg-blue-600 text-white text-xs rounded-lg font-black uppercase tracking-wider shadow-sm shadow-blue-500/20">
                          Prédio: {building.buildingNumber}
                        </span>
                        <span className="px-2 py-1 bg-slate-100 text-slate-500 text-[10px] rounded-lg font-bold uppercase tracking-wider">
                          Prédio
                        </span>
                        {building.isCompleted ? (
                          <span className="px-2 py-1 bg-emerald-100 text-emerald-700 text-[10px] rounded-lg font-black uppercase tracking-wider flex items-center gap-1">
                             <CheckCircle2 className="w-3 h-3" />
                             Concluído
                          </span>
                        ) : building.visitCount && building.visitCount > 0 && (
                          <span className="px-2 py-1 bg-blue-100 text-blue-700 text-[10px] rounded-lg font-black uppercase tracking-wider flex items-center gap-1 text-nowrap">
                             <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" />
                             Iniciado
                          </span>
                        )}
                      </div>
                      <h3 className="font-bold text-slate-900 group-hover:text-blue-600 transition-colors">
                        {building.name || 'Sem nome'}
                      </h3>
                      <p className="text-xs text-slate-500 truncate mt-1 flex items-center gap-1">
                        <MapPin className="w-3 h-3 text-slate-400" />
                        {building.address}
                      </p>
                    </div>
                    <ChevronRight className="w-5 h-5 text-slate-300 group-hover:translate-x-1 group-hover:text-blue-400 transition-all" />
                  </motion.div>
                ))
              )}
            </div>
          </div>
        )}

        {view === 'building' && selectedBuilding && (
          <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-24">
            {/* Building Info Card (Inspired by the document screenshot with Sleek styles) */}
            <div className="bg-white rounded-3xl border border-slate-200 overflow-hidden shadow-xl shadow-slate-200/50">
              {/* Facade Image Slot */}
              <div 
                onClick={() => !selectedBuilding.facadeImageUrl && facadeInputRef.current?.click()}
                className={cn(
                  "h-48 bg-slate-100 relative overflow-hidden",
                  !selectedBuilding.facadeImageUrl ? "cursor-pointer group" : ""
                )}
              >
                {selectedBuilding.facadeImageUrl ? (
                  <img 
                    src={selectedBuilding.facadeImageUrl} 
                    alt="Fachada" 
                    className="w-full h-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center text-slate-400 gap-2">
                    <ImageIcon className="w-8 h-8 opacity-20" />
                    <span className="text-[10px] font-bold uppercase tracking-widest opacity-50 text-slate-500">Adicionar Foto da Fachada</span>
                  </div>
                )}
                {isUpdatingBuilding && (
                  <div className="absolute inset-0 bg-white/60 backdrop-blur-sm flex items-center justify-center z-10">
                    <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                  </div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-slate-900/40 to-transparent pointer-events-none" />
                {selectedBuilding.isCompleted && (
                  <div className="absolute top-4 left-4 z-20">
                    <span className="px-3 py-1.5 bg-emerald-500 text-white text-[10px] font-black uppercase tracking-[0.2em] rounded-full shadow-lg shadow-emerald-500/40 flex items-center gap-2 border border-emerald-400/50 backdrop-blur-md">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Concluído
                    </span>
                  </div>
                )}
              </div>

              <div className="bg-slate-900 px-6 py-4 flex items-center justify-between">
                 <div className="flex gap-4">
                    <div>
                      <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500 mb-1">Prédio</p>
                      <p className="text-white font-black text-xl">{selectedBuilding.buildingNumber}</p>
                    </div>
                 </div>
                 <div className="flex items-center gap-2">
                   <button 
                    onClick={() => {
                      setEditBuildingForm({
                        name: selectedBuilding.name || '',
                        buildingNumber: selectedBuilding.buildingNumber || '',
                        address: selectedBuilding.address || '',
                        apartmentsCount: selectedBuilding.apartmentsCount || ''
                      });
                      setShowEditBuildingModal(true);
                    }}
                    className="flex justify-center items-center w-8 h-8 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500 hover:text-white transition-colors"
                    title="Editar Informações"
                   >
                     <Edit className="w-4 h-4" />
                   </button>
                   <button 
                    onClick={() => setItemToDelete({ type: 'building', id: selectedBuilding.id! })}
                    className="flex justify-center items-center w-8 h-8 bg-red-500/20 text-red-400 rounded-lg hover:bg-red-500 hover:text-white transition-colors"
                    title="Excluir Prédio Inteiro"
                   >
                     <Trash2 className="w-4 h-4" />
                   </button>
                   <button 
                    onClick={() => openInMaps(selectedBuilding.address)}
                    className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-500 transition-colors shadow-lg shadow-blue-500/20"
                  >
                    <Navigation className="w-4 h-4" />
                    GPS
                  </button>
                 </div>
              </div>
              
              <div className="p-6 border-b border-slate-100 bg-slate-50/50">
                   <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Endereço e Instalações</p>
                   <p className="text-slate-900 font-bold text-lg leading-tight">{selectedBuilding.address}</p>
                   {selectedBuilding.name && <p className="font-medium mt-1 text-blue-600">{selectedBuilding.name}</p>}
              </div>

              <div className="grid grid-cols-3 divide-x divide-slate-100 min-h-[100px]">
                <div className="p-4 flex flex-col justify-center">
                   <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400 mb-3">Correio</p>
                   <div className="flex gap-4">
                      <button 
                        onClick={() => handleUpdateBuilding({ mailbox: 'Individual' })}
                        className="flex items-center gap-1.5 text-[10px] font-bold text-slate-600 group"
                      >
                        <div className={cn("w-2.5 h-2.5 rounded-full ring-2 ring-offset-2 transition-all", selectedBuilding.mailbox === 'Individual' ? 'bg-blue-500 ring-blue-500' : 'bg-white ring-slate-200 group-hover:ring-slate-400')} />
                        IND
                      </button>
                      <button 
                        onClick={() => handleUpdateBuilding({ mailbox: 'Coletiva' })}
                        className="flex items-center gap-1.5 text-[10px] font-bold text-slate-600 group"
                      >
                        <div className={cn("w-2.5 h-2.5 rounded-full ring-2 ring-offset-2 transition-all", selectedBuilding.mailbox === 'Coletiva' ? 'bg-slate-900 ring-slate-900' : 'bg-white ring-slate-200 group-hover:ring-slate-400')} />
                        COL
                      </button>
                   </div>
                </div>
                <div className="p-4 flex flex-col justify-center">
                   <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400 mb-3">Interfone</p>
                   <div className="flex gap-4">
                      <button 
                        onClick={() => handleUpdateBuilding({ intercom: 'Sim' })}
                        className="flex items-center gap-1.5 text-[10px] font-bold text-slate-600 group"
                      >
                        <div className={cn("w-2.5 h-2.5 rounded-full ring-2 ring-offset-2 transition-all", selectedBuilding.intercom === 'Sim' ? 'bg-blue-500 ring-blue-500' : 'bg-white ring-slate-200 group-hover:ring-slate-400')} />
                        SIM
                      </button>
                      <button 
                        onClick={() => handleUpdateBuilding({ intercom: 'Não' })}
                        className="flex items-center gap-1.5 text-[10px] font-bold text-slate-600 group"
                      >
                        <div className={cn("w-2.5 h-2.5 rounded-full ring-2 ring-offset-2 transition-all", selectedBuilding.intercom === 'Não' ? 'bg-red-500 ring-red-500' : 'bg-white ring-slate-200 group-hover:ring-slate-400')} />
                        NÃO
                      </button>
                   </div>
                </div>
                <div className="p-4 flex flex-col justify-center text-center">
                   <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400 mb-1">Apartamentos</p>
                   <p className="text-3xl font-black text-slate-900 italic tracking-tighter">
                     {selectedBuilding.apartmentsCount}
                   </p>
                </div>
              </div>
            </div>

            {/* Stats Summary as seen in the theme */}
            <div className="bg-slate-900 rounded-3xl p-6 text-white overflow-hidden relative shadow-xl shadow-slate-900/20">
               <div className="relative z-10">
                 <h4 className="text-xs font-bold uppercase tracking-[0.2em] opacity-50 mb-6">Resumo da Cobertura</h4>
                 <div className="flex justify-between">
                   <div className="text-center px-4">
                      <span className="block text-3xl font-black italic mb-1">
                        {new Set(visits.map(v => v.apartment)).size}
                      </span>
                      <span className="text-[8px] uppercase tracking-widest opacity-60 font-bold block">Visitados</span>
                   </div>
                   <div className="w-px h-10 bg-white/10 self-center" />
                   <div className="text-center px-4">
                      <span className="block text-3xl font-black italic mb-1">
                        {(() => {
                           const total = parseInt(selectedBuilding.apartmentsCount || '0');
                           const uniqueVisited = new Set(visits.map(v => v.apartment)).size;
                           return isNaN(total) ? 0 : Math.max(0, total - uniqueVisited);
                        })()}
                      </span>
                      <span className="text-[8px] uppercase tracking-widest opacity-60 font-bold block">Não trabalhado</span>
                   </div>
                   <div className="w-px h-10 bg-white/10 self-center" />
                   <div className="text-center px-4">
                      <span className="block text-3xl font-black italic mb-1 text-blue-400">
                        {(() => {
                           const total = parseInt(selectedBuilding.apartmentsCount || '0');
                           if (isNaN(total) || total <= 0) return 0;
                           const uniqueVisited = new Set(visits.map(v => v.apartment)).size;
                           return Math.round((uniqueVisited / total) * 100);
                        })()}%
                      </span>
                      <span className="text-[8px] uppercase tracking-widest opacity-60 font-bold block">Alcance</span>
                   </div>
                 </div>
               </div>
               <div className="absolute -right-8 -bottom-8 w-40 h-40 bg-blue-500 rounded-full opacity-10 blur-3xl" />
            </div>

            {/* Visit Selector Layout */}
            <div className="space-y-6">
              <h4 className="font-bold text-slate-900 text-sm flex items-center gap-2 px-1">
                <span className="w-1 h-4 bg-blue-600 rounded-full" />
                Registrar Visita
              </h4>
              <div className="grid grid-cols-4 gap-3">
                {selectedBuilding.apartments.map(apt => {
                  const aptVisits = visits.filter(v => v.apartment === apt);
                  const lastVisit = aptVisits.length > 0 ? aptVisits[0] : null;
                  return (
                    <div key={apt} className="relative group">
                      <button 
                        onClick={() => {
                          setActiveApartment(apt);
                          if (lastVisit) {
                            setVisitContacted(lastVisit.contacted);
                            setVisitNotes(lastVisit.notes || '');
                            setEditingVisitId(lastVisit.id);
                          } else {
                            setVisitContacted(true);
                            setVisitNotes('');
                            setEditingVisitId(null);
                          }
                          setShowVisitModal(true);
                        }}
                        className={cn(
                          "w-full p-4 py-6 rounded-2xl border-2 flex flex-col items-center justify-center transition-all shadow-sm active:scale-95 min-h-[100px]",
                          lastVisit 
                            ? lastVisit.contacted ? 'bg-green-50 border-green-200 text-green-700 shadow-green-100' : 'bg-red-50 border-red-200 text-red-700 shadow-red-100'
                            : 'bg-white border-white hover:border-blue-500 text-slate-600 shadow-slate-100'
                        )}
                      >
                        <span className="text-xl font-black tracking-tighter leading-none mb-1">{apt}</span>
                        {lastVisit && (
                          <div className="mt-2 flex flex-col items-center gap-1">
                             <span className={cn("px-2 py-0.5 text-[8px] font-black uppercase rounded-full", lastVisit.contacted ? 'bg-green-200 text-green-800' : 'bg-red-200 text-red-800')}>
                               {lastVisit.contacted ? 'SIM' : 'NÃO'}
                             </span>
                             <span className="text-[10px] font-bold text-slate-500 whitespace-nowrap">
                              {formatDate(lastVisit.date?.toDate() || new Date())}
                            </span>
                          </div>
                        )}
                      </button>
                    </div>
                  );
                })}
                <button 
                  onClick={() => setShowAddAptModal(true)}
                  className="p-4 py-6 rounded-2xl border-2 border-dashed border-slate-200 flex flex-col items-center justify-center transition-all hover:border-blue-300 hover:bg-blue-50 text-slate-400 group active:scale-95 min-h-[100px]"
                >
                  <Plus className="w-6 h-6 mb-1 text-slate-300 group-hover:text-blue-500 transition-colors" />
                  <span className="text-[10px] font-black uppercase tracking-widest leading-none">Novo</span>
                </button>
              </div>
            </div>

            {/* History UI */}
            <div className="space-y-6">
               <h4 className="font-bold text-slate-900 text-sm flex items-center gap-2 px-1">
                 <span className="w-1 h-4 bg-slate-900 rounded-full" />
                 Histórico de Visitas
               </h4>
               <div className="bg-white rounded-3xl border border-slate-200 overflow-hidden shadow-lg shadow-slate-100">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50/50 border-b border-slate-100">
                        <tr>
                          <th className="pl-6 pr-4 py-4 font-bold text-slate-400 uppercase tracking-widest">Apto</th>
                          <th className="px-4 py-4 font-bold text-slate-400 uppercase tracking-widest">Data</th>
                          <th className="px-4 py-4 font-bold text-slate-400 uppercase tracking-widest text-center">Status</th>
                          <th className="px-4 py-4 font-bold text-slate-400 uppercase tracking-widest text-right pr-6">Ação</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {visits.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="px-6 py-12 text-center text-slate-300 font-medium italic">Nenhuma visita ainda</td>
                          </tr>
                        ) : (
                          visits.map(visit => (
                            <tr key={visit.id} className="hover:bg-slate-50/50 transition-colors">
                              <td className="pl-6 pr-4 py-4 font-black text-slate-900 text-sm tracking-tighter">
                                <div className="flex items-center gap-2">
                                  {visit.apartment}
                                  <button 
                                    type="button"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      handleDeleteAllAptVisits(visit.apartment);
                                    }}
                                    className="p-1 text-red-400 hover:text-red-600 transition-colors"
                                    title={`Limpar todos os registros do apto ${visit.apartment}`}
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                </div>
                              </td>
                              <td className="px-4 py-4 text-slate-500 font-medium">
                                <span className="block">{formatDate(visit.date?.toDate() || new Date())}</span>
                                {visit.notes && <span className="text-[9px] text-slate-400 mt-0.5 line-clamp-1">{visit.notes}</span>}
                              </td>
                              <td className="px-4 py-4">
                                <div className="flex justify-center">
                                  {visit.contacted ? (
                                    <div className="bg-green-100 p-1.5 rounded-lg">
                                       <CheckCircle2 className="w-4 h-4 text-green-600" />
                                    </div>
                                  ) : (
                                    <div className="bg-red-100 p-1.5 rounded-lg">
                                       <XCircle className="w-4 h-4 text-red-600" />
                                    </div>
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-4 text-right pr-6">
                                <div className="flex justify-end gap-1">
                                  <button 
                                    onClick={() => {
                                      setActiveApartment(visit.apartment);
                                      setVisitContacted(visit.contacted);
                                      setVisitNotes(visit.notes || '');
                                      setEditingVisitId(visit.id);
                                      setShowVisitModal(true);
                                    }}
                                    className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                  >
                                    <Edit className="w-4 h-4" />
                                  </button>
                                  <button 
                                    type="button"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      handleDeleteVisit(visit.id);
                                    }}
                                    className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
               </div>
            </div>
          </div>
        )}
      </main>

      {/* Floating Action Button */}
      <div className="fixed bottom-6 right-6 flex flex-col gap-3">
        <input 
          type="file" 
          accept="image/*" 
          className="hidden" 
          ref={facadeInputRef}
          onChange={handleFacadeUpload}
        />
        
      {/* FABs */}
      <div className="fixed bottom-6 right-6 z-40">
        <button 
          onClick={() => setShowManualModal(true)}
          className="bg-blue-600 text-white w-16 h-16 rounded-full shadow-xl shadow-blue-500/30 flex items-center justify-center hover:scale-110 active:scale-95 transition-all group"
        >
          <div className="flex flex-col items-center">
            <Plus className="w-6 h-6 mb-0.5" />
            <span className="text-[8px] font-black uppercase tracking-tighter">Novo</span>
          </div>
        </button>
      </div>
      </div>

      {/* Loading Overlay for AI */}
      <AnimatePresence>
        {isProcessingImage && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-slate-900/80 backdrop-blur-sm flex flex-col items-center justify-center p-6 text-center"
          >
            <div className="relative mb-8">
               <div className="absolute inset-0 animate-ping bg-blue-500 opacity-20 rounded-full" />
               <div className="bg-blue-600 p-6 rounded-full relative">
                  <Camera className="w-10 h-10 text-white" />
               </div>
            </div>
            <h3 className="text-xl font-bold text-white mb-2">Lendo dados do prédio...</h3>
            <p className="text-slate-300 max-w-xs">
              Nossa IA está interpretando a foto para cadastrar o território automaticamente para você.
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Manual Entry Modal */}
      <AnimatePresence>
        {showManualModal && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowManualModal(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              className="relative bg-white w-full max-w-lg rounded-t-[2.5rem] sm:rounded-[2.5rem] p-8 shadow-2xl flex flex-col gap-6"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-2xl font-black text-slate-900 tracking-tighter">Cadastro Inteligente</h3>
                  <p className="text-xs text-slate-400 font-bold uppercase tracking-widest mt-1">Descreva o prédio e aptos</p>
                </div>
                <button onClick={() => setShowManualModal(false)} className="p-2 bg-slate-50 text-slate-400 rounded-full">
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="space-y-4">
                <p className="text-xs text-slate-500 leading-relaxed">
                  Você pode escrever tudo junto! Exemplo: <br/>
                  <span className="italic">"Rua Flores 123, Ed Vitória, 12 aptos: 101, 102, 201, 202. Prédio 10"</span>
                </p>
                
                <textarea 
                  value={manualText}
                  onChange={(e) => setManualText(e.target.value)}
                  placeholder="Cole ou escreva aqui as informações..."
                  className="w-full p-5 bg-slate-50 border-none rounded-3xl text-sm font-medium focus:ring-4 focus:ring-blue-500/10 transition-all min-h-[160px]"
                />

                <button 
                  onClick={handleTextUpload}
                  disabled={isProcessingText || !manualText.trim()}
                  className="w-full py-5 bg-blue-600 text-white rounded-[2rem] font-black text-lg tracking-tight hover:bg-blue-700 transition-all shadow-xl shadow-blue-500/20 active:scale-95 flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isProcessingText ? <Loader2 className="w-6 h-6 animate-spin" /> : "Processar e Cadastrar"}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Visit Registration Modal */}
      <AnimatePresence>
        {showVisitModal && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowVisitModal(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              className="relative bg-white w-full max-w-lg rounded-t-[2.5rem] sm:rounded-[2.5rem] p-8 shadow-2xl flex flex-col gap-6"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-2xl font-black text-slate-900 tracking-tighter">Apto {activeApartment}</h3>
                  <p className="text-xs text-slate-400 font-bold uppercase tracking-widest mt-1">
                    {editingVisitId ? "Editar Registro" : "Nova Visita"}
                  </p>
                </div>
                <button onClick={() => setShowVisitModal(false)} className="p-2 bg-slate-50 text-slate-400 rounded-full">
                  <XCircle className="w-6 h-6" />
                </button>
              </div>

              <div className="space-y-6">
                <div>
                  <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-3">Conseguiu Contato?</label>
                  <div className="grid grid-cols-2 gap-3">
                    <button 
                      onClick={() => setVisitContacted(true)}
                      className={cn(
                        "py-4 rounded-2xl font-black text-sm transition-all flex items-center justify-center gap-2",
                        visitContacted ? "bg-green-100 text-green-700 ring-2 ring-green-500" : "bg-slate-50 text-slate-400 hover:bg-slate-100"
                      )}
                    >
                      <CheckCircle2 className="w-5 h-5" /> Sim
                    </button>
                    <button 
                      onClick={() => setVisitContacted(false)}
                      className={cn(
                        "py-4 rounded-2xl font-black text-sm transition-all flex items-center justify-center gap-2",
                        !visitContacted ? "bg-red-100 text-red-700 ring-2 ring-red-500" : "bg-slate-50 text-slate-400 hover:bg-slate-100"
                      )}
                    >
                      <XCircle className="w-5 h-5" /> Não
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-3">Observação (Opcional)</label>
                  <textarea 
                    value={visitNotes}
                    onChange={(e) => setVisitNotes(e.target.value)}
                    placeholder="Não use este campo para anotar informações pessoais do morador. Este campo deve ser usado apenas se precisar comunicar algo importante, como por exemplo: Pediu para não ser visitado ou outra informação relevante."
                    className="w-full p-5 bg-slate-50 border-none rounded-3xl text-sm font-medium focus:ring-4 focus:ring-blue-500/10 transition-all min-h-[120px]"
                  />
                </div>

                <button 
                  onClick={handleSaveVisit}
                  disabled={isSavingVisit}
                  className="w-full py-5 bg-slate-900 text-white rounded-[2rem] font-black text-lg tracking-tight hover:bg-slate-800 transition-all shadow-xl shadow-slate-900/20 active:scale-95 flex items-center justify-center gap-2"
                >
                  {isSavingVisit ? <Loader2 className="w-6 h-6 animate-spin" /> : (editingVisitId ? "Atualizar Registro" : "Salvar Visita")}
                </button>

                {editingVisitId && (
                  <div className="flex flex-col gap-2">
                    <button 
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        handleDeleteVisit(editingVisitId);
                      }}
                      className="w-full py-4 bg-red-50 text-red-600 rounded-[2rem] font-bold text-sm uppercase tracking-widest hover:bg-red-100 transition-all flex items-center justify-center gap-2"
                    >
                      <Trash2 className="w-4 h-4" /> Limpar Registro
                    </button>
                    <button 
                      onClick={() => {
                        setEditingVisitId(null);
                        setVisitNotes('');
                        setVisitContacted(true);
                      }}
                      className="w-full py-3 text-blue-600 font-bold text-xs uppercase tracking-widest hover:bg-blue-50 rounded-xl transition-all"
                    >
                      Mudar para Nova Visita
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      {/* Password Modal for Report Download */}
      <AnimatePresence>
        {showPasswordModal && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                setShowPasswordModal(false);
                setReportPassword('');
              }}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-md"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="relative bg-white w-full max-w-sm rounded-[2.5rem] p-8 shadow-2xl overflow-hidden"
            >
              <div className="text-center space-y-4">
                <div className="w-16 h-16 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-6">
                  <ShieldCheck className="w-8 h-8" />
                </div>
                <h3 className="text-xl font-black text-slate-900 tracking-tighter">Área Restrita</h3>
                <p className="text-sm text-slate-500 font-medium pb-2">Digite a senha para baixar o relatório de registros.</p>
                
                <input 
                  type="password"
                  value={reportPassword}
                  onChange={(e) => setReportPassword(e.target.value)}
                  placeholder="Senha"
                  className="w-full p-5 bg-slate-50 border-2 border-slate-100 rounded-2xl text-center text-2xl font-black tracking-[0.5em] focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 transition-all outline-none"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleVerifyPasswordAndDownload();
                  }}
                />

                <div className="flex flex-col gap-3 pt-4">
                  <button 
                    onClick={handleVerifyPasswordAndDownload}
                    className="w-full py-4 bg-slate-900 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-slate-800 transition-all shadow-lg active:scale-95"
                  >
                    Confirmar Senha
                  </button>
                  <button 
                    onClick={() => {
                      setShowPasswordModal(false);
                      setReportPassword('');
                    }}
                    className="w-full py-2 text-slate-400 font-bold text-[10px] uppercase tracking-[0.2em] hover:text-slate-600 transition-colors"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      {/* Edit Building Modal */}
      <AnimatePresence>
        {showEditBuildingModal && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowEditBuildingModal(false)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-md"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="relative bg-white w-full max-w-sm rounded-[2.5rem] p-8 shadow-2xl overflow-hidden"
            >
              <div className="space-y-4">
                <div className="w-16 h-16 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mb-6">
                  <Edit className="w-8 h-8" />
                </div>
                <h3 className="text-xl font-black text-slate-900 tracking-tighter">Editar Prédio</h3>
                
                <div className="space-y-3">
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400 ml-2">Nº do Prédio</label>
                    <input 
                      type="text"
                      value={editBuildingForm.buildingNumber}
                      onChange={(e) => setEditBuildingForm({...editBuildingForm, buildingNumber: e.target.value})}
                      className="w-full p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl text-slate-900 font-bold focus:border-blue-500 outline-none transition-all mt-1"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400 ml-2">Nome do Condomínio</label>
                    <input 
                      type="text"
                      value={editBuildingForm.name}
                      onChange={(e) => setEditBuildingForm({...editBuildingForm, name: e.target.value})}
                      placeholder="(Opcional)"
                      className="w-full p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl text-slate-900 font-bold focus:border-blue-500 outline-none transition-all mt-1"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400 ml-2">Endereço Completo</label>
                    <textarea 
                      value={editBuildingForm.address}
                      onChange={(e) => setEditBuildingForm({...editBuildingForm, address: e.target.value})}
                      className="w-full p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl text-slate-900 font-bold focus:border-blue-500 outline-none transition-all mt-1"
                      rows={3}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400 ml-2">Nº de Apartamentos</label>
                    <input 
                      type="number"
                      value={editBuildingForm.apartmentsCount}
                      onChange={(e) => setEditBuildingForm({...editBuildingForm, apartmentsCount: e.target.value})}
                      placeholder="Ex: 8"
                      className="w-full p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl text-slate-900 font-bold focus:border-blue-500 outline-none transition-all mt-1"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-3 pt-4">
                  <button 
                    onClick={() => facadeInputRef.current?.click()}
                    className="w-full py-4 bg-blue-50 text-blue-600 border-2 border-blue-100 rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-blue-100 transition-all active:scale-95 flex items-center justify-center gap-2"
                  >
                    <Camera className="w-5 h-5" />
                    Alterar Foto do Prédio
                  </button>
                  <button 
                    onClick={handleSaveBuildingEdit}
                    disabled={isUpdatingBuilding}
                    className="w-full py-4 bg-slate-900 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-slate-800 transition-all shadow-lg active:scale-95 disabled:opacity-50 flex items-center justify-center"
                  >
                    {isUpdatingBuilding ? <Loader2 className="w-5 h-5 animate-spin" /> : "Salvar Alterações"}
                  </button>
                  <button 
                    onClick={() => setShowEditBuildingModal(false)}
                    className="w-full py-2 text-slate-400 font-bold text-[10px] uppercase tracking-[0.2em] hover:text-slate-600 transition-colors"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Location Prompt Modal */}
      <AnimatePresence>
        {showLocationPrompt && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-slate-900/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="relative bg-white w-full max-w-sm rounded-[2.5rem] p-8 shadow-2xl overflow-hidden"
            >
              <div className="text-center space-y-4">
                <div className="w-16 h-16 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-6">
                  <MapPin className="w-8 h-8" />
                </div>
                <h3 className="text-xl font-black text-slate-900 tracking-tighter">Onde você está?</h3>
                <p className="text-sm text-slate-500 font-medium pb-2">
                  Precisamos da sua <span className="font-bold text-slate-900">localização GPS</span> para facilitar a marcação dos prédios e abrir as rotas do seu território com precisão.
                </p>
                
                <div className="flex flex-col gap-3 pt-4">
                  <button 
                    onClick={requestLocation}
                    className="w-full py-4 bg-blue-600 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-blue-700 transition-all shadow-lg shadow-blue-600/30 active:scale-95"
                  >
                    Permitir Localização
                  </button>
                  <button 
                    onClick={() => setShowLocationPrompt(false)}
                    className="w-full py-2 text-slate-400 font-bold text-[10px] uppercase tracking-[0.2em] hover:text-slate-600 transition-colors"
                  >
                    Pular por agora
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Manual Apartment Modal */}
      <AnimatePresence>
        {showAddAptModal && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                setShowAddAptModal(false);
                setNewAptName('');
              }}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-md"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="relative bg-white w-full max-w-sm rounded-[2.5rem] p-8 shadow-2xl overflow-hidden"
            >
              <div className="text-center space-y-4">
                <div className="w-16 h-16 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-6">
                  <Plus className="w-8 h-8" />
                </div>
                <h3 className="text-xl font-black text-slate-900 tracking-tighter">Adicionar Apartamento</h3>
                <p className="text-sm text-slate-500 font-medium pb-2">Digite o número ou identificação do novo apartamento.</p>
                
                <input 
                  type="text"
                  value={newAptName}
                  onChange={(e) => setNewAptName(e.target.value)}
                  placeholder="Número (Ex: 101, Apto 2)"
                  className="w-full p-5 bg-slate-50 border-2 border-slate-100 rounded-2xl text-center text-xl font-black focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 transition-all outline-none"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddApartment();
                  }}
                />

                <div className="flex flex-col gap-3 pt-4">
                  <button 
                    onClick={handleAddApartment}
                    className="w-full py-4 bg-slate-900 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-slate-800 transition-all shadow-lg active:scale-95"
                  >
                    Adicionar
                  </button>
                  <button 
                    onClick={() => {
                      setShowAddAptModal(false);
                      setNewAptName('');
                    }}
                    className="w-full py-2 text-slate-400 font-bold text-[10px] uppercase tracking-[0.2em] hover:text-slate-600 transition-colors"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {itemToDelete && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setItemToDelete(null)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-md"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="relative bg-white w-full max-w-sm rounded-[2.5rem] p-8 shadow-2xl overflow-hidden"
            >
              <div className="text-center space-y-4">
                <div className="w-16 h-16 bg-red-50 text-red-600 rounded-2xl flex items-center justify-center mx-auto mb-6">
                  <Trash2 className="w-8 h-8" />
                </div>
                <h3 className="text-xl font-black text-slate-900 tracking-tighter">Confirmar Exclusão</h3>
                <p className="text-sm text-slate-500 font-medium pb-2">
                  {itemToDelete.type === 'apartment' 
                    ? `Tem certeza que deseja apagar TODOS os registros do apartamento ${itemToDelete.id}?`
                    : itemToDelete.type === 'building' 
                    ? "Tem certeza que deseja apagar ESTE PRÉDIO inteiro e todas as suas visitas permanentemente?"
                    : "Tem certeza que deseja apagar este registro de visita?"}
                </p>
                <div className="flex flex-col gap-3 pt-4">
                  <button 
                    onClick={() => {
                       if (itemToDelete.type === 'apartment') {
                         handleDeleteAllAptVisits(itemToDelete.id, true);
                       } else if (itemToDelete.type === 'building') {
                         handleDeleteBuilding(itemToDelete.id, true);
                       } else {
                         handleDeleteVisit(itemToDelete.id, true);
                       }
                       setItemToDelete(null);
                    }}
                    className="w-full py-4 bg-red-500 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-red-600 transition-all shadow-lg shadow-red-500/30 active:scale-95"
                  >
                    Sim, Apagar
                  </button>
                  <button 
                    onClick={() => setItemToDelete(null)}
                    className="w-full py-2 text-slate-400 font-bold text-[10px] uppercase tracking-[0.2em] hover:text-slate-600 transition-colors"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      {/* Crop Image Modal */}
      <AnimatePresence>
        {showCropModal && (
          <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-slate-900/90 backdrop-blur-md"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="relative bg-white w-full max-w-lg rounded-[2.5rem] p-6 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xl font-black text-slate-900 tracking-tighter flex items-center gap-2">
                  <Scissors className="w-5 h-5 text-blue-600" />
                  Recortar Imagem
                </h3>
                <button 
                  onClick={() => { setShowCropModal(false); setCropImageBase64(''); }}
                  className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-full transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              
              <div className="flex-1 overflow-auto bg-slate-100/50 rounded-2xl flex items-center justify-center p-2 min-h-[300px]">
                {cropImageBase64 && (
                  <ReactCrop
                    crop={crop}
                    onChange={(c) => setCrop(c)}
                    onComplete={(c) => setCompletedCrop(c)}
                    className="max-h-[50vh] flex items-center justify-center"
                  >
                    <img 
                      ref={imgRef}
                      src={cropImageBase64}
                      alt="Recortar"
                      className="max-h-[50vh] w-auto object-contain"
                    />
                  </ReactCrop>
                )}
              </div>

              <div className="flex flex-col sm:flex-row gap-3 pt-6 mt-auto">
                <button 
                  onClick={() => { setShowCropModal(false); setCropImageBase64(''); }}
                  className="w-full sm:w-1/3 py-4 text-slate-500 font-bold text-[10px] uppercase tracking-[0.2em] hover:bg-slate-50 rounded-2xl transition-colors"
                  disabled={isUpdatingBuilding}
                >
                  Cancelar
                </button>
                <button 
                  onClick={applyCrop}
                  disabled={isUpdatingBuilding}
                  className="w-full sm:w-2/3 py-4 bg-blue-600 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-blue-700 transition-all shadow-lg shadow-blue-600/30 active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isUpdatingBuilding ? <Loader2 className="w-5 h-5 animate-spin" /> : (
                    <>
                      <CheckCircle2 className="w-5 h-5" />
                      Aplicar Recorte
                    </>
                  )}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
