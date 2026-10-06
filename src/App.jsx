import React, { useState, useRef, useMemo } from 'react';
import { FolderOpen, CheckCircle, AlertCircle, XCircle, File, Trash2, FileText, Info, Check, UploadCloud, DownloadCloud, Sparkles, Building2, Calendar, UserCircle } from 'lucide-react';
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

  const renderBadge = (status) => {
    if (status === STATUSES.OK) return (
      <span className="flex items-center gap-1 bg-green-100 text-green-800 px-3 py-1 rounded-full text-xs font-bold w-max">
        <CheckCircle size={14} /> {t(`status_${status}`, lang)}
      </span>
    );
    if ([STATUSES.MISSING, STATUSES.EXPIRED, STATUSES.EXPIRY_DATE_NEEDED].includes(status)) return (
      <span className="flex items-center gap-1 bg-red-100 text-red-800 px-3 py-1 rounded-full text-xs font-bold w-max">
        {status === STATUSES.MISSING ? <XCircle size={14} /> : <AlertCircle size={14} />} {t(`status_${status}`, lang)}
      </span>
    );
    return (
      <span className="flex items-center gap-1 bg-gray-100 text-gray-800 px-3 py-1 rounded-full text-xs font-bold w-max">
        <Info size={14} /> {t(`status_${status}`, lang)}
      </span>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 font-sans pb-16">
      
      {/* Premium Header */}
      <header className="sticky top-0 z-50 bg-gradient-to-r from-blue-700 to-indigo-800 text-white shadow-md px-6 py-4 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <div className="bg-white/20 p-2 rounded-xl backdrop-blur-sm">
            <FileText size={24} className="text-white" />
          </div>
          <h1 className="text-xl md:text-2xl font-bold tracking-tight">
            {t('appTitle', lang)}
          </h1>
        </div>
        
        {/* Sleek Pill Toggle */}
        <div className="flex bg-indigo-900/40 p-1 rounded-full border border-indigo-500/30">
          <button 
            className={`px-5 py-1.5 rounded-full text-sm font-semibold transition-all duration-200 ${lang === 'en' ? 'bg-white text-indigo-700 shadow-sm' : 'text-indigo-100 hover:text-white'}`}
            onClick={() => setLang('en')}
          >
            EN
          </button>
          <button 
            className={`px-5 py-1.5 rounded-full text-sm font-semibold transition-all duration-200 ${lang === 'bn' ? 'bg-white text-indigo-700 shadow-sm' : 'text-indigo-100 hover:text-white'}`}
            onClick={() => setLang('bn')}
          >
            BN
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-10">
        
        {errorMsg && (
          <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl mb-6 flex items-center gap-3 font-medium shadow-sm">
            <AlertCircle size={20} className="shrink-0" /> 
            <p>{errorMsg}</p>
          </div>
        )}

        {!tender && (
          <div className="bg-white shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-100 rounded-2xl p-10 max-w-3xl mx-auto mt-12 transition-all duration-300">
            
            <div 
              className="group border-2 border-dashed border-slate-300 bg-slate-50 hover:bg-indigo-50 hover:border-indigo-400 rounded-2xl p-16 text-center cursor-pointer transition-all duration-200 flex flex-col items-center justify-center gap-6"
              onClick={() => jsonInputRef.current.click()}
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-indigo-400', 'bg-indigo-50'); }}
              onDragLeave={(e) => { e.currentTarget.classList.remove('border-indigo-400', 'bg-indigo-50'); }}
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.classList.remove('border-indigo-400', 'bg-indigo-50');
                const file = e.dataTransfer.files[0];
                if (file) handleJsonUpload({ target: { files: [file] } });
              }}
            >
              <div className="bg-indigo-100 p-6 rounded-full shadow-inner text-indigo-600 group-hover:scale-110 transition-transform duration-300">
                <FolderOpen size={64} strokeWidth={1.5} />
              </div>
              <div>
                <p className="text-2xl font-bold text-slate-800 tracking-tight">{t('uploadReqPrompt', lang)}</p>
                <p className="text-base text-slate-500 mt-2">{t('uploadReqSubPrompt', lang)}</p>
              </div>
              <input type="file" accept=".json" className="hidden" ref={jsonInputRef} onChange={handleJsonUpload} />
            </div>
          </div>
        )}

        {tender && (
          <div className="flex flex-col gap-8">
            
            {/* Top Grid: Tender Info & Status Summary */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              
              {/* Tender Information */}
              <div className="bg-white shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-100 rounded-2xl p-8">
                <h2 className="text-xl font-bold text-slate-800 mb-6 tracking-tight flex items-center gap-2 pb-4 border-b border-slate-100">
                  <Building2 size={24} className="text-blue-600"/>
                  {t('tenderInfo', lang)}
                </h2>
                
                <div className="grid grid-cols-2 gap-y-6 gap-x-4">
                  <div>
                    <p className="text-sm font-bold text-slate-500 uppercase mb-1">{t('tenderId', lang)}</p>
                    <p className="font-semibold text-slate-800 text-base">{tender.tender_id}</p>
                  </div>
                  <div>
                    <p className="text-sm font-bold text-slate-500 uppercase mb-1">{t('title', lang)}</p>
                    <p className="font-semibold text-slate-800 text-base line-clamp-1" title={tender.title}>{tender.title}</p>
                  </div>
                  <div>
                    <p className="text-sm font-bold text-slate-500 uppercase mb-1 flex items-center gap-1"><UserCircle size={16}/> {t('procuringEntity', lang)}</p>
                    <p className="font-semibold text-slate-800 text-base line-clamp-1">{tender.procuring_entity}</p>
                  </div>
                  <div>
                    <p className="text-sm font-bold text-slate-500 uppercase mb-1 flex items-center gap-1"><Building2 size={16}/> {t('bidder', lang)}</p>
                    <p className="font-semibold text-slate-800 text-base line-clamp-1">{tender.bidder}</p>
                  </div>
                  <div className="col-span-2 bg-indigo-50 p-4 rounded-xl border border-indigo-100">
                    <p className="text-sm font-bold text-indigo-500 uppercase mb-1 flex items-center gap-1"><Calendar size={16}/> {t('deadline', lang)}</p>
                    <p className="font-bold text-indigo-900 text-lg">{tender.submission_deadline}</p>
                  </div>
                </div>
              </div>

              {/* Status Summary */}
              <div className="bg-white shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-100 rounded-2xl p-8 flex flex-col">
                <h2 className="text-xl font-bold text-slate-800 mb-6 tracking-tight flex items-center gap-2 pb-4 border-b border-slate-100">
                  <Sparkles size={24} className="text-emerald-500"/>
                  {t('validationSummary', lang)}
                </h2>
                
                <div className="flex-1 flex flex-col justify-center items-center">
                  <div className="text-center mb-6">
                    <span className="text-5xl font-black text-slate-800 tracking-tighter">{stats.ready}</span>
                    <span className="text-xl font-bold text-slate-400 ml-2">/ {requirements.length} {t('ready', lang)}</span>
                  </div>

                  <div className="flex flex-wrap gap-3 justify-center w-full">
                    {stats.missing > 0 && <span className="flex items-center gap-1.5 bg-red-50 text-red-700 px-4 py-2 rounded-xl text-sm font-bold border border-red-200"><XCircle size={18}/> {stats.missing} {t('missing', lang)}</span>}
                    {stats.expired > 0 && <span className="flex items-center gap-1.5 bg-orange-50 text-orange-700 px-4 py-2 rounded-xl text-sm font-bold border border-orange-200"><AlertCircle size={18}/> {stats.expired} {t('expired', lang)}</span>}
                    {stats.optNotProvided > 0 && <span className="flex items-center gap-1.5 bg-slate-50 text-slate-600 px-4 py-2 rounded-xl text-sm font-bold border border-slate-200"><Info size={18}/> {stats.optNotProvided} {t('optNotProvided', lang)}</span>}
                    
                    {blockingReasons.length === 0 && (
                       <span className="flex items-center gap-1.5 bg-green-50 text-green-700 px-5 py-3 rounded-xl text-base font-bold border border-green-200"><CheckCircle size={20}/> Package is ready</span>
                    )}
                  </div>
                </div>
              </div>
              
            </div>

            {/* Bottom Grid: Requirements & Upload */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              
              {/* Requirements & Matching */}
              <div className="lg:col-span-2 bg-white shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-100 rounded-2xl p-8">
                <h2 className="text-xl font-bold text-slate-800 mb-6 tracking-tight flex items-center gap-2 pb-4 border-b border-slate-100">
                  <FileText size={24} className="text-indigo-600"/>
                  {t('documentRequirements', lang)}
                </h2>
                
                <div className="flex flex-col gap-4">
                  {requirementsWithStatus.map(req => (
                    <div key={req.id} className="bg-white hover:shadow-md border border-slate-200 rounded-xl p-5 transition-shadow duration-200 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                      
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <FileText size={18} className="text-slate-400 shrink-0" />
                          <span className="font-bold text-slate-800 text-base">{req.order}. {lang === 'bn' ? req.title_bn : req.title_en}</span>
                        </div>
                        <div className="flex items-center gap-3 pl-7">
                          {renderBadge(req.status)}
                          <span className="text-sm font-semibold text-slate-500">
                            {req.mandatory ? t('mandatory', lang) : t('optional', lang)} • {req.has_expiry ? t('hasExpiry', lang) : t('noExpiry', lang)}
                          </span>
                        </div>
                      </div>
                      
                      <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto">
                        <select 
                          className="flex-1 sm:w-[240px] bg-white border border-slate-300 text-slate-700 rounded-lg px-4 py-2.5 text-sm font-medium shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all cursor-pointer"
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
                            className="bg-white border border-slate-300 text-slate-700 rounded-lg px-4 py-2.5 text-sm font-medium shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all w-full sm:w-auto"
                            value={req.match?.expiryDate || ''} 
                            onChange={(e) => updateExpiry(req.id, e.target.value)}
                          />
                        )}
                      </div>
                      
                    </div>
                  ))}
                </div>
              </div>

              {/* Uploaded Files & Generate Button (STICKY RIGHT COLUMN) */}
              <div className="lg:col-span-1 flex flex-col gap-6 sticky top-28 h-fit">
                
                {/* File Uploader */}
                <div className="bg-white shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-100 rounded-2xl p-6 flex flex-col">
                  <h2 className="text-lg font-bold text-slate-800 mb-4 tracking-tight flex items-center gap-2 pb-3 border-b border-slate-100">
                    <UploadCloud size={20} className="text-blue-600"/>
                    {t('uploadedFiles', lang)}
                  </h2>
                  
                  <div 
                    className="group border-2 border-dashed border-slate-300 bg-slate-50 hover:bg-indigo-50 hover:border-indigo-400 rounded-xl p-6 text-center cursor-pointer transition-all duration-200 flex flex-col items-center gap-3 mb-5"
                    onClick={() => fileInputRef.current.click()}
                    onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-indigo-400', 'bg-indigo-50'); }}
                    onDragLeave={(e) => { e.currentTarget.classList.remove('border-indigo-400', 'bg-indigo-50'); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.currentTarget.classList.remove('border-indigo-400', 'bg-indigo-50');
                      processUploadedFiles(Array.from(e.dataTransfer.files));
                    }}
                  >
                    <div className="p-3 bg-white rounded-full shadow-sm">
                       <UploadCloud size={24} className="text-blue-500" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-slate-700">{t('uploadPrompt', lang)}</p>
                      <p className="text-xs font-semibold text-slate-400 mt-1">{t('maxFiles', lang)}</p>
                    </div>
                    <input type="file" multiple accept=".pdf" className="hidden" ref={fileInputRef} onChange={handlePdfUpload} />
                  </div>
                  
                  <div className="flex flex-col gap-3 max-h-[350px] overflow-y-auto pr-2 custom-scrollbar">
                    {files.map(f => (
                      <div key={f.id} className="flex justify-between items-center bg-white border border-slate-200 shadow-sm rounded-xl p-3 group hover:border-red-200 transition-all duration-200">
                        <div className="flex gap-3 items-center min-w-0">
                          <div className="p-2 bg-red-50 rounded-lg shrink-0">
                            <File size={20} className="text-red-500" />
                          </div>
                          <div className="flex flex-col min-w-0">
                            <span className="text-sm font-semibold text-slate-800 truncate" title={f.name}>{f.name}</span>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-xs font-semibold text-slate-500">{(f.size/1024/1024).toFixed(1)} MB • {f.pages} {t('pages', lang)}</span>
                            </div>
                            {f.isDuplicate && (
                              <span className="bg-orange-100 text-orange-800 px-2 py-0.5 rounded text-xs font-bold mt-1 w-max">
                                {t('duplicate', lang)}
                              </span>
                            )}
                          </div>
                        </div>
                        <button 
                          className="text-slate-400 hover:text-red-600 p-2 rounded-lg hover:bg-red-50 transition-colors shrink-0" 
                          onClick={() => removeFile(f.id)}
                          title="Remove file"
                        >
                          <Trash2 size={18} />
                        </button>
                      </div>
                    ))}
                    {files.length === 0 && (
                      <div className="text-center py-6 text-slate-400 text-sm font-medium">
                        No files uploaded yet.
                      </div>
                    )}
                  </div>
                </div>

                {/* Generate Section */}
                <div className="bg-white shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-100 rounded-2xl p-6">
                  {!generatedPdfBytes ? (
                    <>
                      <button 
                        className={`w-full py-4 text-lg rounded-xl font-bold flex items-center justify-center gap-2 transition-all duration-200 ${
                          blockingReasons.length === 0 && !isGenerating 
                          ? 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white shadow-lg transform hover:-translate-y-0.5' 
                          : 'bg-slate-200 text-slate-400 shadow-none cursor-not-allowed'
                        }`}
                        disabled={blockingReasons.length > 0 || isGenerating}
                        onClick={handleGenerate}
                      >
                        {isGenerating ? (
                          <><div className="animate-spin h-5 w-5 border-2 border-current border-t-transparent rounded-full mr-2"></div> {t('downloading', lang)}</>
                        ) : (
                          <><DownloadCloud size={24}/> {t('generate', lang)}</>
                        )}
                      </button>
                      
                      {blockingReasons.length > 0 && (
                        <div className="mt-4 p-4 bg-red-50 border border-red-100 rounded-xl">
                          <p className="text-sm font-bold text-red-800 flex items-center gap-1.5 mb-2"><AlertCircle size={16}/> {t('blockingErrors', lang)}</p>
                          <ul className="list-disc pl-5 text-sm font-medium text-red-600 space-y-1">
                            {blockingReasons.slice(0, 3).map(br => (
                              <li key={br.id} className="line-clamp-1" title={lang === 'bn' ? br.title_bn : br.title_en}>{br.order}. {lang === 'bn' ? br.title_bn : br.title_en}</li>
                            ))}
                            {blockingReasons.length > 3 && <li className="text-xs italic opacity-80">...and {blockingReasons.length - 3} more</li>}
                          </ul>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="text-center py-4">
                      <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-100 text-green-600 mb-4 shadow-inner">
                        <CheckCircle size={32} />
                      </div>
                      <h3 className="text-xl font-bold text-slate-800 mb-2">{t('successGenerated', lang)}</h3>
                      <p className="text-sm font-medium text-slate-500 mb-6">{tender.tender_id}_Package.pdf</p>
                      <button 
                        className="w-full py-4 text-lg rounded-xl font-bold bg-green-600 hover:bg-green-700 text-white shadow-lg transition-all duration-200 flex justify-center items-center gap-2 transform hover:-translate-y-0.5" 
                        onClick={handleDownload}
                      >
                        <DownloadCloud size={24} /> {t('downloadPackage', lang)}
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
