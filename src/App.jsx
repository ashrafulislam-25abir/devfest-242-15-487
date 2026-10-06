import React, { useState, useRef, useMemo } from 'react';
import { FileJson, CheckCircle2, AlertTriangle, XCircle, File, Trash2, FileCheck2, Info, Check, UploadCloud, DownloadCloud, Sparkles, Building2, Calendar, UserCircle, FileText } from 'lucide-react';
import { calculateSHA256 } from './services/hashService';
import { getPdfPageCount, generatePackage } from './services/pdfService';
import { determineStatus, isBlocking, STATUSES } from './utils/status';
import { t } from './utils/i18n';

function App() {
  const [lang, setLang] = useState('en');
  const [tender, setTender] = useState(null);
  const [requirements, setRequirements] = useState([]);
  
  const [files, setFiles] = useState([]); 
  const [matches, setMatches] = useState({}); 
  
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [generatedPdfBytes, setGeneratedPdfBytes] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  
  const fileInputRef = useRef(null);
  const jsonInputRef = useRef(null);

  const handleJsonUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = JSON.parse(evt.target.result);
        if (data.tender && data.requirements) {
          setTender(data.tender);
          setRequirements(data.requirements.sort((a, b) => a.order - b.order));
          setFiles([]);
          setMatches({});
          setErrorMsg('');
          setSuccessMsg('');
          setGeneratedPdfBytes(null);
        } else {
          setErrorMsg(t('errorLoadJson', lang));
        }
      } catch (err) {
        setErrorMsg(t('errorLoadJson', lang));
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handlePdfUpload = async (e) => {
    const uploadedFiles = Array.from(e.target.files);
    e.target.value = '';
    processUploadedFiles(uploadedFiles);
  };

  const processUploadedFiles = async (newFiles) => {
    setErrorMsg('');
    setSuccessMsg('');
    setGeneratedPdfBytes(null);
    
    let currentSize = files.reduce((acc, f) => acc + f.size, 0);
    let currentCount = files.length;
    
    const validFiles = [];
    
    for (const file of newFiles) {
      if (file.type !== 'application/pdf') {
        setErrorMsg(t('invalidPdf', lang));
        continue;
      }
      if (currentCount >= 30) {
        setErrorMsg(t('countExceeded', lang));
        break;
      }
      if (currentSize + file.size > 50 * 1024 * 1024) {
        setErrorMsg(t('sizeExceeded', lang));
        break;
      }
      
      try {
        const arrayBuffer = await file.arrayBuffer();
        const hash = await calculateSHA256(arrayBuffer);
        const pages = await getPdfPageCount(arrayBuffer);
        
        validFiles.push({
          id: Math.random().toString(36).substring(2, 9),
          fileObj: file,
          name: file.name,
          size: file.size,
          pages,
          hash,
          arrayBuffer
        });
        
        currentSize += file.size;
        currentCount++;
      } catch (err) {
        setErrorMsg(t('invalidPdf', lang) + ' - ' + file.name);
      }
    }
    
    setFiles(prev => {
      const allFiles = [...prev, ...validFiles];
      const hashes = {};
      allFiles.forEach(f => {
        if (hashes[f.hash]) {
          f.isDuplicate = true;
          hashes[f.hash].isDuplicate = true;
        } else {
          hashes[f.hash] = f;
          f.isDuplicate = false;
        }
      });
      return allFiles;
    });
  };

  const removeFile = (fileId) => {
    setGeneratedPdfBytes(null);
    setFiles(prev => {
      const newFiles = prev.filter(f => f.id !== fileId);
      const hashes = {};
      newFiles.forEach(f => f.isDuplicate = false);
      newFiles.forEach(f => {
        if (hashes[f.hash]) {
          f.isDuplicate = true;
          hashes[f.hash].isDuplicate = true;
        } else {
          hashes[f.hash] = f;
        }
      });
      return newFiles;
    });
    
    setMatches(prev => {
      const newMatches = { ...prev };
      Object.keys(newMatches).forEach(reqId => {
        if (newMatches[reqId].fileId === fileId) {
          delete newMatches[reqId];
        }
      });
      return newMatches;
    });
  };

  const updateMatch = (reqId, fileId) => {
    setGeneratedPdfBytes(null);
    setMatches(prev => {
      const newMatches = { ...prev };
      if (!fileId) {
        delete newMatches[reqId];
      } else {
        Object.keys(newMatches).forEach(k => {
          if (newMatches[k].fileId === fileId) {
            delete newMatches[k];
          }
        });
        newMatches[reqId] = { fileId, expiryDate: prev[reqId]?.expiryDate || '' };
      }
      return newMatches;
    });
  };

  const updateExpiry = (reqId, dateStr) => {
    setGeneratedPdfBytes(null);
    setMatches(prev => ({
      ...prev,
      [reqId]: { ...prev[reqId], expiryDate: dateStr }
    }));
  };

  const requirementsWithStatus = useMemo(() => {
    if (!tender) return [];
    return requirements.map(req => {
      const match = matches[req.id];
      const matchedFile = match ? files.find(f => f.id === match.fileId) : null;
      const status = determineStatus(req, matchedFile, match?.expiryDate, tender.submission_deadline);
      return { ...req, match, matchedFile, status };
    });
  }, [requirements, matches, files, tender]);

  const stats = useMemo(() => {
    const s = { ready: 0, missing: 0, expired: 0, optNotProvided: 0 };
    requirementsWithStatus.forEach(req => {
      if (req.status === STATUSES.OK) s.ready++;
      if (req.status === STATUSES.MISSING) s.missing++;
      if (req.status === STATUSES.EXPIRY_DATE_NEEDED || req.status === STATUSES.EXPIRED) s.expired++;
      if (req.status === STATUSES.NOT_PROVIDED) s.optNotProvided++;
    });
    return s;
  }, [requirementsWithStatus]);

  const blockingReasons = useMemo(() => {
    return requirementsWithStatus.filter(req => isBlocking(req.status));
  }, [requirementsWithStatus]);

  const handleGenerate = async () => {
    if (blockingReasons.length > 0 || !tender) return;
    setIsGenerating(true);
    setErrorMsg('');
    setSuccessMsg('');
    
    try {
      const matchedFilesArray = requirementsWithStatus
        .filter(r => r.matchedFile)
        .map(r => ({
          requirementId: r.id,
          fileId: r.match.fileId,
          fileObj: r.matchedFile
        }));
        
      const pdfBytes = await generatePackage({
        tender,
        requirements,
        matchedFiles: matchedFilesArray,
        language: lang
      });
      
      setGeneratedPdfBytes(pdfBytes);
      setSuccessMsg(t('successGenerated', lang));
    } catch (err) {
      setErrorMsg("Failed to generate package: " + err.message);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownload = () => {
    if (!generatedPdfBytes) return;
    const blob = new Blob([generatedPdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${tender.tender_id}_Package.pdf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getBadgeClass = (status) => {
    if (status === STATUSES.OK) return 'bg-emerald-100/80 text-emerald-700 px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wide border border-emerald-200/50 shadow-sm';
    if ([STATUSES.MISSING, STATUSES.EXPIRED, STATUSES.EXPIRY_DATE_NEEDED].includes(status)) return 'bg-rose-100/80 text-rose-700 px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wide border border-rose-200/50 shadow-sm';
    return 'bg-slate-100/80 text-slate-600 px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wide border border-slate-200/50 shadow-sm';
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-slate-50 to-slate-100/80 text-slate-800 font-sans pb-16">
      
      {/* Sticky Header */}
      <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-xl border-b border-slate-200/60 shadow-sm px-6 py-4 flex justify-between items-center transition-all duration-300">
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-tr from-blue-600 to-indigo-600 p-2 rounded-xl shadow-md shadow-indigo-500/20">
            <FileCheck2 size={24} className="text-white" />
          </div>
          <h1 className="text-xl md:text-2xl font-bold bg-gradient-to-r from-blue-700 to-indigo-700 bg-clip-text text-transparent">
            {t('appTitle', lang)}
          </h1>
        </div>
        
        <div className="flex bg-slate-100/80 backdrop-blur-sm p-1 rounded-lg border border-slate-200/50 shadow-inner">
          <button 
            className={`px-4 py-1.5 rounded-md text-sm font-semibold transition-all duration-300 ${lang === 'en' ? 'bg-white shadow-sm text-indigo-700 scale-100' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50 scale-95'}`}
            onClick={() => setLang('en')}
          >
            English
          </button>
          <button 
            className={`px-4 py-1.5 rounded-md text-sm font-semibold transition-all duration-300 ${lang === 'bn' ? 'bg-white shadow-sm text-indigo-700 scale-100' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50 scale-95'}`}
            onClick={() => setLang('bn')}
          >
            বাংলা
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-10">
        
        {errorMsg && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 p-4 rounded-xl mb-6 flex items-center gap-3 font-medium shadow-sm animate-in slide-in-from-top-2">
            <AlertTriangle size={20} className="shrink-0" /> 
            <p>{errorMsg}</p>
          </div>
        )}

        {!tender && (
          <div className="bg-white/90 backdrop-blur-md shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-100 rounded-3xl p-8 max-w-3xl mx-auto mt-12 transition-all duration-500 hover:shadow-[0_8px_30px_rgb(0,0,0,0.08)]">
            <div className="text-center mb-8">
              <h2 className="text-3xl font-bold text-slate-800 mb-2 tracking-tight">Let's build your package.</h2>
              <p className="text-slate-500">Start by uploading the requirements payload provided by the authority.</p>
            </div>
            
            <div 
              className="group border-2 border-dashed border-indigo-200 bg-gradient-to-b from-indigo-50/50 to-blue-50/30 hover:from-indigo-50 hover:to-blue-100 rounded-2xl p-12 text-center cursor-pointer transition-all duration-300 flex flex-col items-center justify-center gap-5"
              onClick={() => jsonInputRef.current.click()}
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-indigo-400'); }}
              onDragLeave={(e) => { e.currentTarget.classList.remove('border-indigo-400'); }}
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.classList.remove('border-indigo-400');
                const file = e.dataTransfer.files[0];
                if (file) handleJsonUpload({ target: { files: [file] } });
              }}
            >
              <div className="bg-white p-4 rounded-full shadow-sm group-hover:-translate-y-2 group-hover:shadow-md transition-all duration-300">
                <FileJson size={40} className="text-indigo-500" />
              </div>
              <div>
                <p className="text-xl font-semibold text-slate-800">{t('uploadReqPrompt', lang)}</p>
                <p className="text-sm text-slate-500 mt-2">{t('uploadReqSubPrompt', lang)}</p>
                <span className="inline-block mt-4 bg-white/80 backdrop-blur-sm border border-slate-200 px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider text-indigo-600 shadow-sm">
                  {t('jsonFilesOnly', lang)}
                </span>
              </div>
              <input type="file" accept=".json" className="hidden" ref={jsonInputRef} onChange={handleJsonUpload} />
            </div>
          </div>
        )}

        {tender && (
          <div className="flex flex-col gap-8 animate-in fade-in duration-500">
            
            {/* Top Grid: Tender Info & Status Summary */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              
              {/* Tender Information */}
              <div className="bg-white/90 backdrop-blur-md shadow-[0_8px_30px_rgb(0,0,0,0.04)] hover:shadow-[0_8px_30px_rgb(0,0,0,0.08)] border border-slate-100 rounded-2xl p-7 transition-all duration-300">
                <h2 className="text-lg font-bold text-slate-800 mb-5 flex items-center gap-2 pb-3 border-b border-slate-100">
                  <div className="p-1.5 bg-blue-50 text-blue-600 rounded-lg"><Building2 size={20}/></div>
                  {t('tenderInfo', lang)}
                </h2>
                
                <div className="grid grid-cols-2 gap-y-5 gap-x-4">
                  <div className="bg-slate-50/50 p-3 rounded-xl border border-slate-100">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">{t('tenderId', lang)}</p>
                    <p className="font-semibold text-slate-800 text-sm">{tender.tender_id}</p>
                  </div>
                  <div className="bg-slate-50/50 p-3 rounded-xl border border-slate-100">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">{t('title', lang)}</p>
                    <p className="font-semibold text-slate-800 text-sm line-clamp-1" title={tender.title}>{tender.title}</p>
                  </div>
                  <div className="bg-slate-50/50 p-3 rounded-xl border border-slate-100">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 flex items-center gap-1"><UserCircle size={12}/> {t('procuringEntity', lang)}</p>
                    <p className="font-semibold text-slate-800 text-sm line-clamp-1">{tender.procuring_entity}</p>
                  </div>
                  <div className="bg-slate-50/50 p-3 rounded-xl border border-slate-100">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 flex items-center gap-1"><Building2 size={12}/> {t('bidder', lang)}</p>
                    <p className="font-semibold text-slate-800 text-sm line-clamp-1">{tender.bidder}</p>
                  </div>
                  <div className="col-span-2 bg-indigo-50/50 p-3 rounded-xl border border-indigo-100">
                    <p className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest mb-1 flex items-center gap-1"><Calendar size={12}/> {t('deadline', lang)}</p>
                    <p className="font-semibold text-indigo-900 text-sm">{tender.submission_deadline}</p>
                  </div>
                </div>
              </div>

              {/* Status Summary */}
              <div className="bg-white/90 backdrop-blur-md shadow-[0_8px_30px_rgb(0,0,0,0.04)] hover:shadow-[0_8px_30px_rgb(0,0,0,0.08)] border border-slate-100 rounded-2xl p-7 flex flex-col transition-all duration-300">
                <h2 className="text-lg font-bold text-slate-800 mb-5 flex items-center gap-2 pb-3 border-b border-slate-100">
                  <div className="p-1.5 bg-emerald-50 text-emerald-600 rounded-lg"><Sparkles size={20}/></div>
                  {t('validationSummary', lang)}
                </h2>
                
                <div className="flex-1 flex flex-col justify-center items-center">
                  
                  {/* Circular Progress conceptually represented by large text */}
                  <div className="relative mb-6">
                    <svg className="w-32 h-32 transform -rotate-90">
                      <circle cx="64" cy="64" r="56" stroke="currentColor" strokeWidth="8" fill="transparent" className="text-slate-100" />
                      <circle cx="64" cy="64" r="56" stroke="currentColor" strokeWidth="8" fill="transparent" strokeDasharray="351.85" strokeDashoffset={351.85 - (351.85 * stats.ready) / requirements.length} className="text-emerald-500 transition-all duration-1000 ease-out" />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className="text-3xl font-black text-slate-800">{stats.ready}</span>
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-0.5">/ {requirements.length} {t('ready', lang)}</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 justify-center w-full">
                    {stats.missing > 0 && <span className="flex items-center gap-1.5 bg-rose-50 text-rose-700 px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider border border-rose-200 shadow-sm"><XCircle size={14}/> {stats.missing} {t('missing', lang)}</span>}
                    {stats.expired > 0 && <span className="flex items-center gap-1.5 bg-orange-50 text-orange-700 px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider border border-orange-200 shadow-sm"><AlertTriangle size={14}/> {stats.expired} {t('expired', lang)}</span>}
                    {stats.optNotProvided > 0 && <span className="flex items-center gap-1.5 bg-slate-50 text-slate-600 px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider border border-slate-200 shadow-sm"><Info size={14}/> {stats.optNotProvided} {t('optNotProvided', lang)}</span>}
                    
                    {blockingReasons.length === 0 && (
                       <span className="flex items-center gap-1.5 bg-emerald-50 text-emerald-700 px-4 py-2 rounded-xl text-sm font-bold uppercase tracking-wider border border-emerald-200 shadow-sm"><CheckCircle2 size={16}/> Package is ready</span>
                    )}
                  </div>
                </div>
              </div>
              
            </div>

            {/* Bottom Grid: Requirements & Upload */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              
              {/* Requirements & Matching */}
              <div className="lg:col-span-2 bg-white/90 backdrop-blur-md shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-100 rounded-2xl p-7">
                <h2 className="text-lg font-bold text-slate-800 mb-5 flex items-center gap-2 pb-3 border-b border-slate-100">
                  <div className="p-1.5 bg-indigo-50 text-indigo-600 rounded-lg"><FileText size={20}/></div>
                  {t('documentRequirements', lang)}
                </h2>
                
                <div className="flex flex-col gap-3">
                  {requirementsWithStatus.map(req => (
                    <div key={req.id} className="bg-slate-50/50 hover:bg-white border border-slate-100 hover:border-indigo-100 hover:shadow-sm rounded-xl p-5 transition-all duration-300 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 group">
                      
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <span className="font-bold text-slate-800 text-[15px]">{req.order}. {lang === 'bn' ? req.title_bn : req.title_en}</span>
                          <span className={getBadgeClass(req.status)}>{t(`status_${req.status}`, lang)}</span>
                        </div>
                        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                          <span className={req.mandatory ? 'text-indigo-500' : ''}>{req.mandatory ? t('mandatory', lang) : t('optional', lang)}</span>
                          <span className="w-1 h-1 rounded-full bg-slate-300"></span>
                          <span>{req.has_expiry ? t('hasExpiry', lang) : t('noExpiry', lang)}</span>
                        </div>
                      </div>
                      
                      <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto">
                        <select 
                          className="flex-1 sm:w-[220px] bg-white border border-slate-200 text-slate-700 rounded-lg px-3 py-2.5 text-sm font-medium shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all cursor-pointer hover:border-indigo-300"
                          value={req.match?.fileId || ''} 
                          onChange={(e) => updateMatch(req.id, e.target.value)}
                        >
                          <option value="">-- {t('matchFile', lang)} --</option>
                          {files.map(f => {
                            const usedByOther = Object.entries(matches).find(([rId, m]) => {
                              if (rId === req.id) return false;
                              const matchedFile = files.find(file => file.id === m.fileId);
                              return matchedFile && matchedFile.hash === f.hash;
                            });
                            return (
                              <option key={f.id} value={f.id} disabled={!!usedByOther}>
                                {f.name} {usedByOther ? '(In use / Dup)' : ''}
                              </option>
                            )
                          })}
                        </select>
                        
                        {req.has_expiry && req.match?.fileId && (
                          <input 
                            type="date" 
                            className="bg-white border border-slate-200 text-slate-700 rounded-lg px-3 py-2.5 text-sm font-medium shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all hover:border-indigo-300 w-full sm:w-auto"
                            value={req.match?.expiryDate || ''} 
                            onChange={(e) => updateExpiry(req.id, e.target.value)}
                          />
                        )}
                      </div>
                      
                    </div>
                  ))}
                </div>
              </div>

              {/* Uploaded Files & Generate Button */}
              <div className="lg:col-span-1 flex flex-col gap-8">
                
                {/* File Uploader */}
                <div className="bg-white/90 backdrop-blur-md shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-100 rounded-2xl p-7 flex-1 flex flex-col">
                  <h2 className="text-lg font-bold text-slate-800 mb-5 flex items-center gap-2 pb-3 border-b border-slate-100">
                    <div className="p-1.5 bg-blue-50 text-blue-600 rounded-lg"><UploadCloud size={20}/></div>
                    {t('uploadedFiles', lang)}
                  </h2>
                  
                  <div 
                    className="group border-2 border-dashed border-blue-200 bg-slate-50 hover:bg-blue-50/50 hover:border-blue-400 rounded-xl p-6 text-center cursor-pointer transition-all duration-300 flex flex-col items-center gap-3 mb-5"
                    onClick={() => fileInputRef.current.click()}
                    onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-blue-400', 'bg-blue-50'); }}
                    onDragLeave={(e) => { e.currentTarget.classList.remove('border-blue-400', 'bg-blue-50'); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.currentTarget.classList.remove('border-blue-400', 'bg-blue-50');
                      processUploadedFiles(Array.from(e.dataTransfer.files));
                    }}
                  >
                    <div className="p-3 bg-white rounded-full shadow-sm group-hover:-translate-y-1 transition-transform duration-300">
                       <UploadCloud size={24} className="text-blue-500" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-slate-700">{t('uploadPrompt', lang)}</p>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mt-1">{t('maxFiles', lang)}</p>
                    </div>
                    <input type="file" multiple accept=".pdf" className="hidden" ref={fileInputRef} onChange={handlePdfUpload} />
                  </div>
                  
                  <div className="flex flex-col gap-3 max-h-[380px] overflow-y-auto pr-2 custom-scrollbar">
                    {files.map(f => (
                      <div key={f.id} className="flex justify-between items-center bg-white border border-slate-100 shadow-sm rounded-xl p-3 group hover:border-red-200 hover:shadow-md transition-all duration-300">
                        <div className="flex gap-3 items-center min-w-0">
                          <div className="p-2 bg-rose-50 rounded-lg shrink-0">
                            <File size={20} className="text-rose-500" />
                          </div>
                          <div className="flex flex-col min-w-0">
                            <span className="text-sm font-semibold text-slate-800 truncate" title={f.name}>{f.name}</span>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{(f.size/1024/1024).toFixed(1)} MB • {f.pages} {t('pages', lang)}</span>
                            </div>
                            {f.isDuplicate && (
                              <span className="bg-orange-100 text-orange-700 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide mt-1 inline-block w-max">
                                {t('duplicate', lang)}
                              </span>
                            )}
                          </div>
                        </div>
                        <button 
                          className="text-slate-300 hover:text-rose-600 p-2 rounded-lg hover:bg-rose-50 transition-colors shrink-0" 
                          onClick={() => removeFile(f.id)}
                          title="Remove file"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    ))}
                    {files.length === 0 && (
                      <div className="text-center py-10 text-slate-400 text-sm font-medium">
                        No files uploaded yet.
                      </div>
                    )}
                  </div>
                </div>

                {/* Generate Section */}
                <div className="bg-white/90 backdrop-blur-md shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-100 rounded-2xl p-7">
                  {!generatedPdfBytes ? (
                    <>
                      <button 
                        className={`w-full py-4 text-base rounded-xl font-bold flex items-center justify-center gap-2 transition-all duration-300 ${
                          blockingReasons.length === 0 && !isGenerating 
                          ? 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white shadow-lg shadow-indigo-500/30 transform hover:-translate-y-0.5' 
                          : 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed'
                        }`}
                        disabled={blockingReasons.length > 0 || isGenerating}
                        onClick={handleGenerate}
                      >
                        {isGenerating ? (
                          <><div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full mr-2"></div> {t('downloading', lang)}</>
                        ) : (
                          <><DownloadCloud size={20}/> {t('generate', lang)}</>
                        )}
                      </button>
                      
                      {blockingReasons.length > 0 && (
                        <div className="mt-4 p-4 bg-rose-50/80 border border-rose-100 rounded-xl">
                          <p className="text-xs font-bold uppercase tracking-wider text-rose-700 flex items-center gap-1.5 mb-2"><AlertTriangle size={14}/> {t('blockingErrors', lang)}</p>
                          <ul className="list-disc pl-5 text-sm font-medium text-rose-600 space-y-1">
                            {blockingReasons.slice(0, 3).map(br => (
                              <li key={br.id} className="line-clamp-1" title={lang === 'bn' ? br.title_bn : br.title_en}>{br.order}. {lang === 'bn' ? br.title_bn : br.title_en}</li>
                            ))}
                            {blockingReasons.length > 3 && <li className="text-xs italic opacity-80">...and {blockingReasons.length - 3} more</li>}
                          </ul>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="text-center py-5 animate-in zoom-in duration-300">
                      <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-100 text-emerald-500 mb-4 shadow-inner">
                        <CheckCircle2 size={32} />
                      </div>
                      <h3 className="text-xl font-bold text-slate-800 mb-1">{t('successGenerated', lang)}</h3>
                      <p className="text-sm font-medium text-slate-500 mb-6">{tender.tender_id}_Package.pdf</p>
                      <button 
                        className="w-full py-4 text-base rounded-xl font-bold bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 text-white shadow-lg shadow-emerald-500/30 transition-all duration-300 flex justify-center items-center gap-2 transform hover:-translate-y-0.5" 
                        onClick={handleDownload}
                      >
                        <DownloadCloud size={20} /> {t('downloadPackage', lang)}
                      </button>
                    </div>
                  )}
                </div>

              </div>
            </div>

          </div>
        )}
      </main>
    </div>
  );
}

export default App;
