"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useRef, useEffect } from "react";
import Image from "next/image";
import logo from "../../assets/logo.png";
import toast from "react-hot-toast";
import { supabase } from "@/lib/supabaseClient";


export default function SubmissionsPage() {
  const router = useRouter();
  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001/api';
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(false);
  const modelId = searchParams.get("modelId");
  const [model, setModel] = useState(null);
  const [submissions, setSubmissions] = useState([]);
  const [user, setUser] = useState(null);
  const [userEmail, setUserEmail] = useState(null);
  const [userId, setUserId] = useState(null);
  const [selected, setSelected] = useState([]);
  const [showError, setShowError] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showViewModal, setShowViewModal] = useState(false);
  const [activeSubmission, setActiveSubmission] = useState(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [hoveredId, setHoveredId] = useState(null);
  const [submissionDeleting, setSubmissionDeleting] = useState(null);
  const dropdownRef = useRef(null);
  const [trainModelName, setTrainModelName] = useState("");
  const [training, setTraining] = useState(false);
  const [manualPath, setManualPath] = useState("");

  const handleTrainSubmit = async (e) => {
    e.preventDefault();
    setTraining(true);
    if (!trainModelName.trim()) { toast.error("Model name required"); return; }
    if (!manualPath) { toast.error("Please put a folder path"); return; }
    //console.log(modelId);
    const payload = {
      modelName: trainModelName,
      userId: userId,
      base_mid: modelId,
      absolutePath: manualPath
    };
    try {
      const response = await fetch(`${backendUrl}/models/fineTune`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const result = await response.json();
      if (response.ok) {
        toast.success(`Success! Model saved in ${manualPath}.`);
        setShowUploadModal(false);
      } else {
        toast.error(result.error);
      }
      setTrainModelName("");
      setManualPath("");
    } catch (err) {
      toast.error("Connection failed");
    } finally {
      setTraining(false);
    }
  };

  useEffect(() => {
    function handleClickOutside(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    async function init() {
      setLoading(true);

      // 1. Get model brief first
      const res = await fetch(`${backendUrl}/models/brief/${modelId}`);
      const data = await res.json();
      //console.log("Model brief data:", data);
      const fetchedLanguageId = data[0].lid;
      const fetchedModelName = data[0].model_name;
      setModel(fetchedModelName);

      // 2. Get user
      const { data: { user } } = await supabase.auth.getUser();
      setUserEmail(user.email);
      setUserId(user.id);
      //console.log("Authenticated user:", user);
      const userRes = await fetch(`${backendUrl}/profile/info?userId=${user.id}`);
      const userData = await userRes.json();
      setUser(userData[0]);
      //console.log("Profile info:", userData);

      // 3. Now fetch submissions
      const subRes = await fetch(
        `${backendUrl}/submissions/available?languageId=${fetchedLanguageId}&modelId=${modelId}`
      );
      const subData = await subRes.json();
      //console.log("Fetched submissions:", subData);
      setSubmissions(Array.isArray(subData) ? subData : []);

      setLoading(false);
    }

    if (modelId) init(); // guard: don't run if modelId is still null
  }, [modelId]);

  const toggleSelection = (e, id) => {
    e.stopPropagation(); // Prevents the modal from opening when clicking the checkbox
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
    //console.log("Toggled selection for ID:", id);
  };

  const handleOpenView = (submission) => {
    setActiveSubmission(submission);
    setShowViewModal(true);
  };

  const handleDelete = async (sid, uid, readings_file) => {
    if (uid !== userId) {
      setShowError(true);
      return;
    }
    //console.log(readings_file);

    try {
      const response = await fetch(`${backendUrl}/submissions/${sid}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json', // <--- This is the missing piece!
        },
        body: JSON.stringify({
          readings_file: readings_file,
        }),
      });
      setSelected(prev => prev.filter(id => id !== sid));
      if (response.ok) {
        setSubmissions(prev => prev.filter(s => s.sid !== sid));
        setSubmissionDeleting(null);
        toast.success("Submission deleted successfully");
      } else {
        const err = await response.json();
        toast.error(`Error: ${err.error}`);
      }
    } catch (err) {
      console.error("Delete failed:", err);
    }
  };

  const handleDownload = (selected) => {
    if (!selected || selected.length === 0) return toast.error("Select items first");
    //console.log("Initiating download for IDs:", selected);
    const idsParam = selected.join(',');
    window.open(`${backendUrl}/submissions/download?ids=${idsParam}`, '_blank');
  };

  const selectedCount = selected.length;
  const myCount = submissions.filter(s => s.uid === userId).length;


  if (loading) return (<div style={s.page}>
    <style>{`        
                        .loader-overlay {
                          position: fixed;
                          top: 0;
                          left: 0;
                          width: 100vw;
                          height: 100vh;
                          display: flex;
                          justify-content: center;
                          align-items: center;
                          z-index: 9999; /* Ensures it stays on top */
                        }

                        /* The themed spinner */
                        .main-spinner {
                          width: 80px;
                          height: 80px;
                          border: 5px solid #28568b;
                          border-radius: 50%;
                          border-top-color: #deeaea;
                          animation: spin 1s linear infinite;
                        }

                        @keyframes spin { 
                          to { transform: rotate(360deg); } 
                        `}
    </style>
    <div className="loader-overlay">
      <div className="main-spinner"></div>
    </div>
  </div>);


  return (
    <div style={s.page}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600&family=DM+Sans:wght@300;400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'DM Sans', sans-serif; background: #f7f8fc; }
        input::placeholder { color: #a0aec0; }
        input:focus { outline: none; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slideDown { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
        .sub-item { animation: fadeUp 0.35s ease both; }
        .sub-item:nth-child(2) { animation-delay: 0.05s; }
        .sub-item:nth-child(3) { animation-delay: 0.10s; }
        .sub-item:nth-child(4) { animation-delay: 0.15s; }
        .action-btn:hover { background: #0f3460 !important; transform: translateY(-1px); }
        .upload-btn:hover { background: rgba(226,185,111,0.12) !important; transform: translateY(-1px); }
        .delete-btn:hover { background: rgba(239,68,68,0.15) !important; color: #ef4444 !important; }
        .delete-btn2:hover { background: #af1d1d !important; }
        .close-btn:hover { background: #f0f0f0 !important; }
        .save-btn:hover { background: #0f3460 !important; }
        .cancel-btn:hover { background: #e2e8f0 !important; }
        .info-clickable-area:hover { background-color: rgba(0, 123, 255, 0.1); max-width: 120px; text-decoration: none;}
        .logout-item:hover { background: #fff5f5 !important; color: #c0392b !important; }
        .dd-item:hover { background: #f7f8fc !important; }
        .dropdown-item:hover { background: #f7f8fc !important; }
        .modal-overlay { animation: fadeIn 0.2s ease; }
        .modal-box { animation: slideUp 0.25s ease; }
        input[type="file"]::file-selector-button {
          padding: 6px 12px; border-radius: 8px; border: none;
          background: #1a1a2e; color: #e2b96f; cursor: pointer;
          font-family: 'DM Sans', sans-serif; font-size: 12px;
          margin-right: 10px;
        }
      `}</style>

      <nav style={s.nav}>
        <div style={s.navBrand}>
          <div ><Image src={logo} alt="Logo" width="50" height="50" /></div>
          <span style={s.navName}>صوتك</span>
        </div>

        <div style={s.userArea} ref={dropdownRef}>
          <button style={s.userPill} onClick={() => setDropdownOpen(o => !o)}>
            <div style={s.avatar}>{user?.initials}</div>
            <span style={s.userName}>{user?.username}</span>
            <span style={{ color: '#a0aec0', fontSize: '11px', marginLeft: '4px' }}>
              {dropdownOpen ? '▲' : '▼'}
            </span>
          </button>

          {dropdownOpen && (
            <div style={s.dropdown}>
              <div style={s.dropdownHeader}>
                <div style={{ ...s.avatar, width: '36px', height: '36px', fontSize: '13px' }}>{user?.initials}</div>
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 500, color: '#1a1a2e' }}>{user?.username}</div>
                  <div style={{ fontSize: '11px', color: '#b4b4b4' }}>{userEmail}</div>
                </div>
              </div>
              <div style={s.dropdownDivider} />
              <button onClick={() => router.push("/models")} className="dropdown-item" style={s.dropdownItem}>Models</button>
              <div style={s.dropdownDivider} />
              <button onClick={() => router.push("/")} className="dropdown-item" style={s.dropdownItem}>Home</button>
              <div style={s.dropdownDivider} />
              <button onClick={() => router.push("/login")} className="logout-item" style={{ ...s.dropdownItem, color: '#e74c3c' }}>
                Sign out →
              </button>
            </div>
          )}
        </div>
      </nav>

      {/* MAIN */}
      <main style={s.main}>

        {/* Page header */}
        <div style={s.pageHeader}>
          <div>
            <div style={s.breadcrumb}>models / {model}</div>
          </div>

          {/* Stats row */}
          <div style={s.statsRow}>
            {[
              { label: 'Total', value: submissions.length },
              { label: 'Owned by me', value: myCount },
              { label: 'Selected', value: selectedCount },
            ].map(stat => (
              <div key={stat.label} style={s.statPill}>
                <span style={s.statVal}>{stat.value}</span>
                <span style={s.statLabel}>{stat.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Action bar */}
        <div style={s.actionBar}>
          <div style={s.actionLeft}>
            <button
              className="action-btn"
              style={{ ...s.actionBtn, opacity: selectedCount === 0 ? 0.4 : 1 }}
              onClick={() => handleDownload(selected)}
              disabled={selectedCount === 0}
            >
              Download Selected
            </button>
          </div>
          <button
            className="upload-btn"
            style={s.uploadBtn}
            onClick={() => setShowUploadModal(true)}
          >
            + Fine tune
          </button>
        </div>

        {/* List */}
        {submissions.length === 0 ? (
          <div style={s.emptyState}>
            <div style={s.emptyIcon}>📂</div>
            <p style={s.emptyText}>No submissions left to fine tune {model}.</p>
          </div>
        ) : (
          <div style={s.list}>
            {submissions.map((submission) => {
              const isSelected = selected.includes(submission.sid);
              return (
                <div
                  key={submission.sid}
                  className="sub-item"
                  style={{
                    ...s.item,
                    ...(isSelected ? s.itemSelected : {}),
                    ...(hoveredId === submission.sid && !isSelected ? s.itemHover : {}),
                    cursor: 'pointer' // Shows the whole box is interactive
                  }}
                  // 1. Clicking the box now toggles selection
                  onClick={(e) => toggleSelection(e, submission.sid)}
                  onMouseEnter={() => setHoveredId(submission.sid)}
                  onMouseLeave={() => setHoveredId(null)}
                >
                  {isSelected && <div style={s.itemAccent} />}

                  {/* Checkbox reflects state */}
                  <div style={{ ...s.checkbox, ...(isSelected ? s.checkboxChecked : {}) }}>
                    {isSelected && <span style={s.checkMark}>✓</span>}
                  </div>

                  <div style={s.fileIcon}>📄</div>

                  {/* 2. Clicking the info area triggers the View Modal */}
                  <div
                    style={{
                      ...s.itemInfo,
                      padding: '4px 8px',
                      borderRadius: '4px',
                      transition: 'background 0.2s'
                    }}
                  >
                    <span style={s.itemName}>{submission.submission_name}</span>
                    {/* 3. Visual cue for the signs part */}
                    <span style={{
                      ...s.itemMeta,
                      color: '#007bff',
                      textDecoration: 'underline',
                      fontWeight: '500',
                      padding: '2px 10px',
                      borderRadius: '20px',
                      border: 'none',
                      width: 'fit-content',
                    }}
                      className="info-clickable-area"
                      onClick={(e) => {
                        e.stopPropagation(); // Prevents the box-level toggleSelection from firing
                        handleOpenView(submission);
                      }}
                    >
                      {submission.language} • {submission.signs.length} signs
                    </span>
                  </div>
                  <div style={{ ...s.ownerBadge, ...(submission.uid === userId ? s.ownerBadgeMe : s.ownerBadgeOther) }}>
                    {submission.uid === userId ? 'Owned' : 'Shared'}
                  </div>

                  <button
                    className="delete-btn"
                    style={s.deleteBtn}
                    onClick={(e) => {
                      e.stopPropagation(); // Prevents toggleSelection
                      setShowDeleteModal(true);
                      setSubmissionDeleting(submission);
                    }}
                  >
                    Delete
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* ERROR MODAL */}
      {showError && (
        <div className="modal-overlay" style={s.overlay} onClick={() => setShowError(false)}>
          <div className="modal-box" style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalHeader}>
              <div style={s.modalIconWrap}>
                <span style={{ fontSize: 22 }}>⚠️</span>
              </div>
              <button className="close-btn" style={s.closeBtn} onClick={() => setShowError(false)}>✕</button>
            </div>
            <h2 style={s.modalTitle}>Permission Error</h2>
            <p style={s.modalBody}>
              You are not the owner of one or more selected submissions. You can only merge submissions that belong to you.
            </p>
            <button
              style={{ ...s.saveBtn, background: '#dc2626', marginTop: 8 }}
              onClick={() => setShowError(false)}
            >
              Understood
            </button>
          </div>
        </div>
      )}
      {/* Confirm Delete MODAL */}
      {showDeleteModal && (
        <div className="modal-overlay" style={s.overlay} onClick={() => setShowDeleteModal(false)}>
          <div className="modal-box" style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalHeader}>
              <div style={s.modalIconWrap}>
                <span style={{ fontSize: 22 }}>⚠️</span>
              </div>
              <button className="close-btn" style={s.closeBtn} onClick={() => setShowDeleteModal(false)}>✕</button>
            </div>
            <h2 style={s.modalTitle}>Deleting</h2>
            <p style={s.modalBody}>
              Are you sure you want to delete this submission? This action cannot be undone.
            </p>
            <button
              className="delete-btn2"
              style={{ ...s.deleteBtn2, marginTop: 8, marginRight: 20 }}
              onClick={() => { setShowDeleteModal(false); handleDelete(submissionDeleting?.sid, submissionDeleting?.uid, submissionDeleting?.readings_file); }}
            >
              Delete
            </button>
            <button
              className="cancel-btn"
              style={{ ...s.cancelBtn, marginTop: 8 }}
              onClick={() => setShowDeleteModal(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Submission MODAL */}
      {showViewModal && activeSubmission && (
        <div className="modal-overlay" style={s.overlay} onClick={() => setShowViewModal(false)}>
          <div className="modal-box" style={{ ...s.modal, maxWidth: '500px' }} onClick={e => e.stopPropagation()}>
            <div style={s.modalHeader}>
              <div>
                <h2 style={s.modalTitle}>{activeSubmission.submission_name}</h2>
                <p style={s.modalSub}>Signs included in this session</p>
              </div>
              <button className="close-btn" style={s.closeBtn} onClick={() => setShowViewModal(false)}>✕</button>
            </div>

            <div style={s.signsContainer}>
              {activeSubmission.signs.map((sign, idx) => (
                <div key={idx} style={s.signTag}>
                  {sign}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TRAIN MODAL */}
      {showUploadModal && (
        <div className="modal-overlay" style={s.overlay} onClick={() => setShowUploadModal(false)}>
          <div className="modal-box" style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalHeader}>
              <div>
                <h2 style={s.modalTitle}>Train model</h2>
                <p style={s.modalSub}>Add a folder</p>
              </div>
              <button className="close-btn" style={s.closeBtn} onClick={() => setShowUploadModal(false)}>✕</button>
            </div>

            <form onSubmit={handleTrainSubmit} style={s.form}>
              <div style={s.fieldGroup}>
                <label style={s.label}>Model name</label>
                <input
                  type="text"
                  placeholder="e.g. ESL 2.1.2"
                  value={trainModelName}
                  onChange={e => setTrainModelName(e.target.value)}
                  style={s.input}
                  onFocus={e => Object.assign(e.target.style, s.inputFocus)}
                  onBlur={e => Object.assign(e.target.style, { borderColor: '#e2e8f0', boxShadow: 'none' })}
                />
              </div>

              <div style={s.fieldGroup}>
                <label style={s.label}>Training Data Directory</label>
                <input
                  placeholder="Paste folder path: D:/Data/Batch1"
                  value={manualPath}
                  onChange={(e) => setManualPath(e.target.value)}
                  style={s.input}
                />
              </div>

              <div style={s.modalActions}>
                <button type="submit" className="save-btn" style={s.saveBtn}>{training ? 'Training...' : 'Fine tune'}</button>
                <button
                  type="button"
                  className="cancel-btn"
                  style={s.cancelBtn}
                  onClick={() => setShowUploadModal(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

const s = {
  page: {
    minHeight: '100vh',
    background: '#f7f8fc',
    fontFamily: "'DM Sans', sans-serif",
  },

  /* NAV */
  nav: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0 32px', height: '64px',
    background: '#ffffff',
    borderBottom: '1px solid #edf0f7',
    boxShadow: '0 1px 12px rgba(0,0,0,0.04)',
    position: 'sticky', top: 0, zIndex: 10,
  },
  navBrand: { display: 'flex', alignItems: 'center', gap: '10px' },
  navLogo: { color: '#e2b96f', fontSize: '20px' },
  navName: {
    fontFamily: "'Playfair Display', serif",
    fontSize: '20px', fontWeight: 600, color: '#1a1a2e', letterSpacing: '0.5px',
  },
  userArea: { position: 'relative' },
  userPill: {
    display: 'flex', alignItems: 'center', gap: '10px',
    padding: '6px 14px 6px 6px',
    background: '#f7f8fc', border: '1.5px solid #edf0f7',
    borderRadius: '100px', cursor: 'pointer',
  },
  avatar: {
    width: 30, height: 30, borderRadius: '50%',
    background: 'linear-gradient(135deg, #1a1a2e, #0f3460)',
    color: '#e2b96f', display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '11px', fontWeight: 600, letterSpacing: '0.5px', flexShrink: 0,
  },
  userName: { fontSize: '13.5px', fontWeight: 500, color: '#1a1a2e' },
  chevron: { fontSize: '10px', color: '#a0aec0' },
  dropdown: {
    position: 'absolute', top: 'calc(100% + 8px)', right: 0,
    background: '#ffffff', borderRadius: '16px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.10)',
    border: '1px solid #edf0f7', minWidth: '200px', overflow: 'hidden',
    animation: 'slideDown 0.15s ease', zIndex: 100,
  },
  ddHeader: {
    display: 'flex', alignItems: 'center', gap: '12px',
    padding: '14px 16px', background: '#fafbfc',
  },
  ddName: { fontSize: '13px', fontWeight: 500, color: '#1a1a2e' },
  ddEmail: { fontSize: '11px', color: '#a0aec0' },
  ddDivider: { height: '1px', background: '#edf0f7' },
  ddItem: {
    display: 'block', width: '100%', padding: '11px 16px',
    background: 'transparent', border: 'none', textAlign: 'left',
    fontSize: '13.5px', color: '#4a5568', cursor: 'pointer',
    transition: 'background 0.15s',
    fontFamily: "'DM Sans', sans-serif",
  },
  dropdown: {
    position: 'absolute',
    top: 'calc(100% + 8px)',
    right: 0,
    background: '#ffffff',
    borderRadius: '16px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.10)',
    border: '1px solid #edf0f7',
    minWidth: '200px',
    overflow: 'hidden',
    animation: 'fadeIn 0.15s ease',
    zIndex: 100,
  },
  dropdownHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '14px 16px',
    background: '#fafbfc',
  },
  dropdownDivider: {
    height: '1px',
    background: '#edf0f7',
    margin: '0',
  },
  dropdownItem: {
    display: 'block',
    width: '100%',
    padding: '11px 16px',
    background: 'transparent',
    border: 'none',
    textAlign: 'left',
    fontSize: '13.5px',
    color: '#4a5568',
    cursor: 'pointer',
    transition: 'background 0.15s, color 0.15s',
    fontFamily: "'DM Sans', sans-serif",
  },

  /* MAIN */
  main: { padding: '36px 40px', maxWidth: '960px', margin: '0 auto' },

  pageHeader: {
    display: 'flex', justifyContent: 'space-between',
    alignItems: 'flex-end', marginBottom: '28px',
    flexWrap: 'wrap', gap: '16px',
  },
  breadcrumb: { fontSize: '12px', color: '#a0aec0', marginBottom: '6px', letterSpacing: '0.3px' },
  pageTitle: {
    fontFamily: "'Playfair Display', serif",
    fontSize: '30px', fontWeight: 600, color: '#1a1a2e',
  },

  statsRow: { display: 'flex', gap: '10px' },
  statPill: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '10px 18px', borderRadius: '12px',
    background: '#ffffff', border: '1px solid #edf0f7',
    boxShadow: '0 1px 6px rgba(0,0,0,0.04)',
  },
  statVal: {
    fontFamily: "'Playfair Display', serif",
    fontSize: '20px', fontWeight: 600, color: '#e2b96f',
  },
  statLabel: { fontSize: '11px', color: '#a0aec0', marginTop: '2px' },

  /* ACTION BAR */
  actionBar: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: '20px', gap: '12px', flexWrap: 'wrap',
  },
  actionLeft: { display: 'flex', gap: '10px' },
  actionBtn: {
    padding: '10px 18px',
    background: '#1a1a2e', color: '#ffffff',
    border: 'none', borderRadius: '10px',
    fontSize: '13.5px', fontWeight: 500, cursor: 'pointer',
    transition: 'background 0.2s, transform 0.15s',
    fontFamily: "'DM Sans', sans-serif",
    letterSpacing: '0.3px',
  },
  uploadBtn: {
    padding: '10px 20px',
    background: 'transparent',
    color: '#1a1a2e',
    border: '1.5px solid #1a1a2e',
    borderRadius: '10px',
    fontSize: '13.5px', fontWeight: 500, cursor: 'pointer',
    transition: 'background 0.2s, transform 0.15s',
    fontFamily: "'DM Sans', sans-serif",
  },

  /* LIST */
  list: { display: 'flex', flexDirection: 'column', gap: '10px' },

  item: {
    display: 'flex', alignItems: 'center', gap: '14px',
    padding: '18px 20px',
    background: '#ffffff', borderRadius: '16px',
    borderColor: '#edf0f7',
    borderWidth: '1.5px',
    borderStyle: 'solid',
    boxShadow: '0 1px 8px rgba(0,0,0,0.04)',
    cursor: 'pointer',
    transition: 'border-color 0.2s, box-shadow 0.2s, background 0.2s',
    position: 'relative', overflow: 'hidden',
  },
  itemHover: {
    borderColor: '#c8d0e0',
    boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
  },
  itemSelected: {
    borderColor: '#0f3460',
    background: '#f0f4ff',
    boxShadow: '0 4px 16px rgba(15,52,96,0.10)',
  },
  itemAccent: {
    position: 'absolute', left: 0, top: 0, bottom: 0,
    width: '4px',
    background: 'linear-gradient(180deg, #1a1a2e, #e2b96f)',
    borderRadius: '4px 0 0 4px',
  },
  checkbox: {
    width: 20, height: 20, borderRadius: '6px',
    borderStyle: 'solid',
    borderWidth: '2px',
    borderColor: '#cbd5e0',
    background: '#f7f8fc',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, transition: 'all 0.15s',
  },
  checkboxChecked: {
    background: '#1a1a2e', borderColor: '#1a1a2e',
  },
  checkMark: { color: '#e2b96f', fontSize: '12px', fontWeight: 700 },

  fileIcon: { fontSize: '20px', flexShrink: 0 },

  itemInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: '2px' },
  itemName: { fontSize: '14.5px', fontWeight: 500, color: '#1a1a2e' },
  itemMeta: { fontSize: '12px', color: '#a0aec0' },

  ownerBadge: {
    padding: '4px 10px', borderRadius: '100px',
    fontSize: '11.5px', fontWeight: 500, flexShrink: 0,
  },
  ownerBadgeMe: { background: '#ecfdf5', color: '#059669', border: '1px solid #a7f3d0' },
  ownerBadgeOther: { background: '#fef3c7', color: '#b45309', border: '1px solid #fde68a' },

  deleteBtn: {
    padding: '7px 14px', borderRadius: '8px',
    background: 'rgba(220,38,38,0.06)', color: '#dc2626',
    border: '1px solid rgba(220,38,38,0.15)',
    fontSize: '13px', fontWeight: 500, cursor: 'pointer',
    transition: 'background 0.15s, color 0.15s',
    fontFamily: "'DM Sans', sans-serif", flexShrink: 0,
  },

  emptyState: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', padding: '80px 20px',
    background: '#ffffff', borderRadius: '20px',
    border: '1.5px dashed #e2e8f0',
  },
  emptyIcon: { fontSize: '48px', marginBottom: '16px', opacity: 0.4 },
  emptyText: { fontSize: '15px', color: '#a0aec0' },

  /* MODALS */
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(10,15,30,0.45)',
    backdropFilter: 'blur(6px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 50,
  },
  modal: {
    background: '#ffffff', borderRadius: '24px',
    width: '100%', maxWidth: '420px',
    padding: '32px',
    boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
  },
  modalHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
    marginBottom: '20px',
  },
  modalIconWrap: {
    width: 44, height: 44, borderRadius: '12px',
    background: '#fff7ed', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  modalTitle: {
    fontFamily: "'Playfair Display', serif",
    fontSize: '22px', fontWeight: 600, color: '#1a1a2e', marginBottom: '4px',
  },
  deleteBtn2: {
    padding: '13px', background: '#dc2626', color: '#ffffff',
    border: 'none', borderRadius: '12px',
    fontSize: '14.5px', fontWeight: 500, cursor: 'pointer',
    transition: 'background 0.2s',
    fontFamily: "'DM Sans', sans-serif",
  },
  modalSub: { fontSize: '13px', color: '#a0aec0', fontWeight: 300 },
  modalBody: { fontSize: '14px', color: '#4a5568', lineHeight: 1.6, marginBottom: '4px' },
  closeBtn: {
    width: 34, height: 34, borderRadius: '50%',
    border: 'none', background: '#f7f8fc',
    cursor: 'pointer', fontSize: '13px', color: '#7a8499',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'background 0.2s', flexShrink: 0,
  },
  form: { display: 'flex', flexDirection: 'column', gap: '20px' },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: '8px' },
  label: { fontSize: '13px', fontWeight: 500, color: '#4a5568', letterSpacing: '0.3px' },
  input: {
    padding: '13px 16px', borderRadius: '12px',
    border: '1.5px solid #e2e8f0', fontSize: '14px',
    color: '#1a202c', background: '#fafbfc',
    transition: 'border-color 0.2s, box-shadow 0.2s',
    fontFamily: "'DM Sans', sans-serif",
  },
  inputFocus: { borderColor: '#0f3460', boxShadow: '0 0 0 3px rgba(15,52,96,0.08)' },
  fileArea: {
    padding: '14px 16px', borderRadius: '12px',
    border: '1.5px dashed #e2e8f0', background: '#fafbfc',
  },
  fileName: { marginTop: '8px', fontSize: '12px', color: '#059669' },
  modalActions: { display: 'flex', flexDirection: 'column', gap: '10px' },
  saveBtn: {
    padding: '13px', background: '#1a1a2e', color: '#ffffff',
    border: 'none', borderRadius: '12px',
    fontSize: '14.5px', fontWeight: 500, cursor: 'pointer',
    transition: 'background 0.2s',
    fontFamily: "'DM Sans', sans-serif",
  },
  cancelBtn: {
    padding: '12px', background: '#f1f5f9', color: '#4a5568',
    border: 'none', borderRadius: '12px',
    fontSize: '14px', cursor: 'pointer',
    transition: 'background 0.2s',
    fontFamily: "'DM Sans', sans-serif",
  },
  /* overlay: { position: 'fixed', inset: 0, background: 'rgba(10,15,30,0.45)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 },
  modal: { background: '#ffffff', borderRadius: '24px', width: '90%', padding: '32px', boxShadow: '0 20px 60px rgba(0,0,0,0.15)' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', marginBottom: '20px' },
  modalTitle: { fontFamily: "'Playfair Display', serif", fontSize: '22px', color: '#1a1a2e' },
  modalSub: { fontSize: '13px', color: '#a0aec0' }, */
  closeBtn: { width: 34, height: 34, borderRadius: '50%', border: 'none', background: '#f7f8fc', cursor: 'pointer' },
  saveBtn: { padding: '13px', background: '#1a1a2e', color: '#ffffff', border: 'none', borderRadius: '12px', cursor: 'pointer' },
  signsContainer: { display: 'flex', flexWrap: 'wrap', gap: '8px', maxHeight: '300px', overflowY: 'auto', padding: '4px' },
  signTag: { padding: '8px 16px', background: '#f0f4ff', border: '1px solid #e2e8f0', borderRadius: '10px', fontSize: '13.5px', color: '#0f3460', fontWeight: 500 },
};
