import React, { useState, useRef, useMemo, useEffect } from 'react';
import { FileUp, FileJson, CheckCircle2, AlertTriangle, XCircle, File, Trash2, FileCheck2, Info, Check, UploadCloud, DownloadCloud } from 'lucide-react';
import { calculateSHA256 } from './services/hashService';
import { getPdfPageCount, generatePackage } from './services/pdfService';
import { determineStatus, isBlocking, STATUSES } from './utils/status';
import { t } from './utils/i18n';

function App() {
  const [lang, setLang] = useState('en');
  const [tender, setTender] = useState(null);
  const [requirements, setRequirements] = useState([]);
  
  const [files, setFiles] = useState([]); // { id, file, name, size, pages, hash, isDuplicate }
  const [matches, setMatches] = useState({}); // reqId -> { fileId, expiryDate }
  
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

  return (
    <div className="container">
      <div className="header-bar">
        <div className="header-title">
          <h1><FileCheck2 className="file-drop-icon" size={28} style={{padding: '6px', width: '40px', height: '40px'}}/> {t('appTitle', lang)}</h1>
          <p>{t('subtitle', lang)}</p>
        </div>
        <div className="lang-switch">
          <button className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>English</button>
          <button className={lang === 'bn' ? 'active' : ''} onClick={() => setLang('bn')}>বাংলা</button>
        </div>
      </div>

      {errorMsg && (
        <div className="alert-error">
          <AlertTriangle size={20} /> {errorMsg}
        </div>
      )}

      {!tender && (
        <div className="card">
          <div 
            className="file-drop-area" 
            onClick={() => jsonInputRef.current.click()}
            onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }}
            onDragLeave={(e) => { e.currentTarget.classList.remove('drag-over'); }}
            onDrop={(e) => {
              e.preventDefault();
              e.currentTarget.classList.remove('drag-over');
              const file = e.dataTransfer.files[0];
              if (file) {
                 const evt = { target: { files: [file] } };
                 handleJsonUpload(evt);
              }
            }}
          >
            <FileJson className="file-drop-icon" size={48} />
            <div>
              <p className="file-drop-text" style={{fontSize: '1.1rem'}}>{t('uploadReqPrompt', lang)}</p>
              <p className="file-drop-subtext">{t('uploadReqSubPrompt', lang)}</p>
              <p className="file-drop-subtext" style={{marginTop: '0.5rem'}}>{t('jsonFilesOnly', lang)}</p>
            </div>
            <input type="file" accept=".json" style={{display: 'none'}} ref={jsonInputRef} onChange={handleJsonUpload} />
          </div>
        </div>
      )}

      {tender && (
        <div className="main-grid">
          <div className="left-column">
            
            <div className="card" style={{padding: '1rem 2rem', background: 'var(--success-bg)', borderColor: '#a7f3d0', display: 'flex', alignItems: 'center', gap: '1rem'}}>
              <CheckCircle2 color="var(--success)" size={24} />
              <div>
                <p style={{color: 'var(--success)', fontWeight: '600'}}>{t('reqLoadedSuccess', lang)}</p>
                <p style={{fontSize: '0.85rem', color: '#065f46'}}>{t('tenderId', lang)}: {tender.tender_id} • {requirements.length} Requirements</p>
              </div>
            </div>

            <div className="card">
              <h2 className="card-title"><Info size={20}/> {t('tenderInfo', lang)}</h2>
              <div className="info-grid">
                <div className="info-item"><span className="info-label">{t('tenderId', lang)}</span><span className="info-value">{tender.tender_id}</span></div>
                <div className="info-item"><span className="info-label">{t('title', lang)}</span><span className="info-value">{tender.title}</span></div>
                <div className="info-item"><span className="info-label">{t('procuringEntity', lang)}</span><span className="info-value">{tender.procuring_entity}</span></div>
                <div className="info-item"><span className="info-label">{t('bidder', lang)}</span><span className="info-value">{tender.bidder}</span></div>
                <div className="info-item"><span className="info-label">{t('deadline', lang)}</span><span className="info-value">{tender.submission_deadline}</span></div>
              </div>
            </div>

            <div className="card">
              <h2 className="card-title"><FileCheck2 size={20}/> {t('documentRequirements', lang)}</h2>
              <div className="req-list">
                {requirementsWithStatus.map(req => (
                  <div key={req.id} className="req-row">
                    <div className="req-info">
                      <div className="req-title">
                        <span>{req.order}. {lang === 'bn' ? req.title_bn : req.title_en}</span>
                        <span className={`badge badge-${req.status}`}>{t(`status_${req.status}`, lang)}</span>
                      </div>
                      <div className="req-meta">
                        <span>{req.mandatory ? t('mandatory', lang) : t('optional', lang)}</span>
                        <span>•</span>
                        <span>{req.has_expiry ? t('hasExpiry', lang) : t('noExpiry', lang)}</span>
                      </div>
                    </div>
                    
                    <div className="req-actions">
                      <div className="input-group">
                        <select 
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
                                {f.name} {usedByOther ? '(In use / Duplicate)' : ''}
                              </option>
                            )
                          })}
                        </select>
                      </div>
                      
                      {req.has_expiry && req.match?.fileId && (
                        <div className="input-group">
                          <input 
                            type="date" 
                            value={req.match?.expiryDate || ''} 
                            onChange={(e) => updateExpiry(req.id, e.target.value)}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

          </div>
          
          <div className="right-column">
            
            <div className="card">
              <h2 className="card-title" style={{fontSize: '1.1rem'}}><UploadCloud size={18}/> {t('validationSummary', lang)}</h2>
              
              <div className="summary-stats">
                <h3>{stats.ready} / {requirements.length} {t('totalReqs', lang)}</h3>
              </div>
              
              <div style={{display:'flex', flexDirection:'column', gap:'0.75rem', marginBottom: '1.5rem'}}>
                <div className="stat-pill" style={{color: 'var(--success)'}}><CheckCircle2 size={16}/> {stats.ready} {t('ready', lang)}</div>
                {stats.missing > 0 && <div className="stat-pill" style={{color: 'var(--error)'}}><XCircle size={16}/> {stats.missing} {t('missing', lang)}</div>}
                {stats.expired > 0 && <div className="stat-pill" style={{color: '#d97706'}}><AlertTriangle size={16}/> {stats.expired} {t('expired', lang)}</div>}
                {stats.optNotProvided > 0 && <div className="stat-pill" style={{color: 'var(--secondary-color)'}}><Info size={16}/> {stats.optNotProvided} {t('optNotProvided', lang)}</div>}
              </div>

              {blockingReasons.length > 0 ? (
                <div className="blocking-error">
                  <div className="blocking-title"><AlertTriangle size={18}/> {t('blockingErrors', lang)}</div>
                  <ul className="blocking-list">
                    {blockingReasons.map(br => (
                      <li key={br.id}>{br.order}. {lang === 'bn' ? br.title_bn : br.title_en} ({t(`status_${br.status}`, lang)})</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="alert-success" style={{marginBottom: '1.5rem', padding: '0.75rem'}}>
                  <Check size={18} /> {t('allReady', lang)}
                </div>
              )}
              
              {!generatedPdfBytes ? (
                <button 
                  className="btn btn-generate" 
                  disabled={blockingReasons.length > 0 || isGenerating}
                  onClick={handleGenerate}
                >
                  {isGenerating ? t('downloading', lang) : t('generate', lang)}
                </button>
              ) : (
                <div className="success-state">
                  <CheckCircle2 size={48} className="success-icon" />
                  <h3 className="success-title">{t('successGenerated', lang)}</h3>
                  <p className="success-meta">{tender.tender_id}_Package.pdf</p>
                  <button className="btn btn-generate" onClick={handleDownload} style={{background: 'var(--success)'}}>
                    <DownloadCloud size={20} /> {t('downloadPackage', lang)}
                  </button>
                </div>
              )}
            </div>

            <div className="card">
              <h2 className="card-title" style={{fontSize: '1.1rem'}}><File size={18}/> {t('uploadedFiles', lang)}</h2>
              <div 
                className="file-drop-area"
                style={{padding: '2rem 1rem'}}
                onClick={() => fileInputRef.current.click()}
                onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }}
                onDragLeave={(e) => { e.currentTarget.classList.remove('drag-over'); }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.remove('drag-over');
                  processUploadedFiles(Array.from(e.dataTransfer.files));
                }}
              >
                <UploadCloud className="file-drop-icon" size={32} />
                <div>
                  <p className="file-drop-text">{t('uploadPrompt', lang)}</p>
                  <p className="file-drop-subtext" style={{marginTop: '0.25rem'}}>{t('maxFiles', lang)}</p>
                </div>
                <input type="file" multiple accept=".pdf" style={{display: 'none'}} ref={fileInputRef} onChange={handlePdfUpload} />
              </div>
              
              <div className="file-list">
                {files.map(f => (
                  <div key={f.id} className="file-item">
                    <div className="file-item-info">
                      <File className="file-icon" size={36} />
                      <div className="file-details">
                        <span className="file-name">{f.name}</span>
                        <span className="file-meta">
                          {(f.size/1024/1024).toFixed(2)} MB • {f.pages} {t('pages', lang)}
                          {Object.values(matches).some(m => m.fileId === f.id) && <span style={{color: 'var(--success)', fontWeight: '600'}}>✓ {t('matched', lang)}</span>}
                        </span>
                        {f.isDuplicate && <span className="file-duplicate">{t('duplicate', lang)}</span>}
                      </div>
                    </div>
                    <button className="btn btn-danger" onClick={() => removeFile(f.id)}><Trash2 size={18} /></button>
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}

export default App;
