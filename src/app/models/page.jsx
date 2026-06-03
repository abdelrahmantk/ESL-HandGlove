"use client";
import { useState, useRef, useEffect } from "react";
import Image from "next/image";
import logo from "../assets/logo.png";
import trash from "../assets/trash.png";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import toast from "react-hot-toast";


export default function ModelsPage() {
  const router = useRouter();
  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001/api';
  const codeLink = process.env.NEXT_PUBLIC_CODE_LINK || "https://colab.research.google.com/drive/12pumKVipWAKbLppJ41ji5-ewFlgNYkTx";
  const [loading, setLoading] = useState(false);
  const [user, setUser] = useState(null);
  const [userEmail, setUserEmail] = useState(null);
  const [userId, setUserId] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [showTrainModal, setShowTrainModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [modelDeleting, setModelDeleting] = useState(null);
  const [languages, setLanguages] = useState([]);
  const [modelName, setModelName] = useState("");
  const [models, setModels] = useState([]);
  const [selectedLang, setSelectedLang] = useState("");
  const [pickleFile, setPickleFile] = useState(null);
  const [showError, setShowError] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdown2Open, setDropdown2Open] = useState(false);
  const [selectedLangName, setSelectedLangName] = useState(null);
  const dropdownRef = useRef(null);
  const languageRef = useRef(null);
  const [trainModelName, setTrainModelName] = useState("");
  const [training, setTraining] = useState(false);

  // Add these new states at the top of ModelsPage component
  const [progress, setProgress] = useState(0);
  const [trainingStatus, setTrainingStatus] = useState("idle"); // idle, local-setup, training, completed, failed
  const socketRef = useRef(null);

  const handleTrainSubmit = async (e) => {
    e.preventDefault();
    if (!trainModelName.trim()) { toast.error("Model name required"); return; }

    setTraining(true);
    setTrainingStatus("local-setup");
    setProgress(0);

    try {
      // 1. Initialize session on backend (we only strictly need the modelName for backend logging now)
      const response = await fetch(`${backendUrl}/models/train`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelName: trainModelName, userId })
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Initialization failed");

      const currentSessionId = result.sessionId;

      // 2. Connect to WebSocket for live updates
      const socketServer = backendUrl.replace('/api', '');
      const io = (await import("socket.io-client")).default;
      socketRef.current = io(socketServer);

      socketRef.current.on("connect", () => {
        socketRef.current.emit("join_session", currentSessionId);
      });

      socketRef.current.on("training_progress", (data) => {
        setProgress(data.progress);
        if (data.status === 'training') setTrainingStatus("training");
        if (data.status === 'completed') {
          setTrainingStatus("completed");
          toast.success("Training Finished Successfully!");
          setTraining(false);
          setShowTrainModal(false);
          reget();
          socketRef.current.disconnect();
        }
        if (data.status === 'failed') {
          setTrainingStatus("failed");
          toast.error(`Training failed: ${data.errorMessage}`);
          setTraining(false);
          socketRef.current.disconnect();
        }
      });

      // 3. Launch Colab passing ONLY the session ID inside the hash (#) fragment
      // This keeps it clean and strips out scary API endpoints from the URL bar
      const colabLink = "https://colab.research.google.com/drive/12pumKVipWAKbLppJ41ji5-ewFlgNYkTx";
      window.open(`${colabLink}#session=${currentSessionId}`, "_blank");

      toast.success("Google Colab opened! Run the cells to start training.", { icon: "🚀" });

    } catch (err) {
      toast.error(err.message || "Connection failed");
      setTraining(false);
      setTrainingStatus("idle");
    }
  };

  useEffect(() => {
    function handleClickOutside(e) {
      // Check User Dropdown
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
      // Check Language Dropdown
      if (languageRef.current && !languageRef.current.contains(e.target)) {
        setDropdown2Open(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    async function init() {
      setLoading(true);

      // 1. Get model brief first
      const res = await fetch(`${backendUrl}/models/models`);
      const data = await res.json();
      //console.log("models:", data);
      setModels(data);

      // 2. Get user
      const { data: { user } } = await supabase.auth.getUser();
      setUserEmail(user.email);
      setUserId(user.id);
      //console.log("Authenticated user:", user);
      const userRes = await fetch(`${backendUrl}/profile/info?userId=${user.id}`);
      const userData = await userRes.json();
      setUser(userData[0]);
      //console.log("Profile info:", userData);

      //3. Get Languages
      const res2 = await fetch(`${backendUrl}/languages/languages`);
      const data2 = await res2.json();
      //console.log("languages:", data2);
      setLanguages(data2);

      setLoading(false);
    }

    init();
  }, []);

  async function reget() {
    setLoading(true);
    const res = await fetch(`${backendUrl}/models/models`);
    const data = await res.json();
    //console.log("models:", data);
    setModels(data);
    const res2 = await fetch(`${backendUrl}/languages/languages`);
    const data2 = await res2.json();
    //console.log("languages:", data2);
    setLanguages(data2);
    setLoading(false);
  };

  const handleDelete = async (mid, uid, model_file) => {
    if (uid !== userId) {
      setShowError(true);
      return;
    }

    try {
      const response = await fetch(`${backendUrl}/models/${mid}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json', // <--- This is the missing piece!
        },
        body: JSON.stringify({
          model_file: model_file,
        }),
      });
      if (response.ok) {
        setModels(prev => prev.filter(m => m.mid !== mid));
        setModelDeleting(null);
        toast.success("Model deleted successfully");
      } else {
        const err = await response.json();
        toast.error(`Error: ${err.error}`);
      }
    } catch (err) {
      console.error("Delete failed:", err);
    }
  };

  const extractBaseMidFromPickle = (pickleFile) => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const buffer = e.target.result;
          const bytes = new Uint8Array(buffer);
          const text = new TextDecoder('latin1').decode(bytes);

          // Find "base_mid" key in the pickle binary text
          const key = 'base_mid';
          const keyIndex = text.indexOf(key);
          if (keyIndex === -1) {
            resolve(null);
            return;
          }

          // After the key, pickle encodes the next string value with a length-prefixed short string
          // Format: ... \x8c<len_byte><string> ...
          let i = keyIndex + key.length;
          while (i < bytes.length) {
            // 0x8c = SHORT_BINUNICODE opcode (string up to 255 chars)
            if (bytes[i] === 0x8c) {
              const strLen = bytes[i + 1];
              const value = new TextDecoder('utf-8').decode(
                bytes.slice(i + 2, i + 2 + strLen)
              );
              resolve(value);
              return;
            }
            i++;
          }
          resolve(null);
        } catch {
          resolve(null);
        }
      };
      reader.onerror = () => resolve(null);
      reader.readAsArrayBuffer(pickleFile);
    });
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!modelName.trim() || !selectedLang || !pickleFile) {
      toast.error("Please provide a name, select a language, and upload a file.");
      return;
    }
    if (modelName.trim()) {
      try {
        const base_mid = await extractBaseMidFromPickle(pickleFile);
        if (!base_mid) {
          toast.error("Could not extract base_mid from the pickle file.");
          return;
        }
        //console.log(base_mid);
        const response = await fetch(`${backendUrl}/models/addModel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: userId,
            lid: selectedLang,
            base_mid: base_mid,
            modelName: modelName,
            fileContent: pickleFile,
          })
        });
        const result = await response.json();

        if (result.success) {
          toast.success("Added successfully!");
          setShowModal(false);
          setModelName("");
          setSelectedLang(null);
          setSelectedLangName(null);
          setPickleFile(null);
          reget();
        } else {
          throw new Error(result.message);
        }
      } catch (err) {
        toast.error("ERROR: " + err.message);
      }
    }
  };

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
        .delete-data-btn:hover{background:rgb(148, 35, 35) !important;}
        .close-btn:hover { background: #f0f0f0 !important; }
        .save-btn:hover { background: #0f3460 !important; }
        .cancel-btn:hover { background: #e2e8f0 !important; }
        .info-clickable-area:hover { background-color: rgba(0, 123, 255, 0.1); max-width: 120px; text-decoration: none;}
        .logout-item:hover { background: #fff5f5 !important; color: #c0392b !important; }
        .dropdown-item:hover { background: #f7f8fc !important; }
        .select-item:hover { background: #f7f8fc !important; }
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
              <button onClick={() => router.push("/")} className="dropdown-item" style={s.dropdownItem}>Home</button>
              <div style={s.dropdownDivider} />
              <button onClick={() => router.push("/login")} className="logout-item" style={{ ...s.dropdownItem, color: '#e74c3c' }}>
                Sign out →
              </button>
            </div>
          )}
        </div>
      </nav>

      {/* MAIN CONTENT */}
      <main style={s.main}>
        <div style={s.pageHeader}>
          <div>
            <h1 style={s.pageTitle}>Models</h1>
            <p style={s.pageSubtitle}>{models.length} Models configured</p>
          </div>
          <div>
            <button
              className="add-lang-btn"
              style={s.addBtn}
              onClick={() => setShowModal(true)}
            >
              + Upload Model
            </button>
            <button
              className="add-lang-btn"
              style={s.addBtn}
              onClick={() => setShowTrainModal(true)}
            >
              + Train new Model
            </button>
          </div>
        </div>

        <div style={s.grid}>
          {models
            .filter((model) => model.mid !== 0) // Remove models where mid is 0
            .map((model, i) => (
              <div key={model.mid || `${model.model_name}-${i}`} className="lang-card" style={{ ...s.card, ...s.cardHover }}>
                <div style={s.cardAccent} />
                <div style={s.cardHeader}>
                  <div style={s.cardIcon}>
                    {model.model_name ? model.model_name.charAt(0) : "M"}
                  </div>
                  <button
                    className="delete-data-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowDeleteModal(true);
                      setModelDeleting(model);
                    }}
                    style={s.deleteBtn}
                  >
                    <Image src={trash} alt="delete" width="18" height="18" />
                  </button>
                </div>
                <h2 style={s.cardTitle}>{model.model_name}</h2>
                <p style={s.cardMeta}>{model.language_name}</p>
                <div style={s.cardButtons}>
                  <button onClick={(e) => { e.stopPropagation(); router.push(`/models/${model.mid}?modelId=${model.mid}`); }} className="add-data-btn" style={s.addDataBtn}>
                    Fine tune
                  </button>
                </div>
              </div>
            ))}
        </div>
      </main>

      {/* MODAL */}
      {showModal && (
        <div style={s.overlay} onClick={() => setShowModal(false)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div style={s.modalHeader}>
              <div>
                <h2 style={s.modalTitle}>Upload Model</h2>
                <p style={s.modalSub}>Configure your model details and upload the pickle file.</p>
              </div>
              <button
                className="close-btn"
                style={s.closeBtn}
                onClick={() => {
                  setModelName("");
                  setSelectedLang("");
                  setPickleFile(null);
                  setShowModal(false);
                }}
              >
                ✕
              </button>
            </div>

            <form style={s.form} onSubmit={e => e.preventDefault()}>

              {/* Model Name */}
              <div style={s.fieldGroup}>
                <label style={s.label}>Model Name</label>
                <input
                  placeholder="e.g. Arabic-v1"
                  value={modelName}
                  onChange={e => setModelName(e.target.value)}
                  style={s.input}
                  onFocus={e => Object.assign(e.target.style, { borderColor: '#0f3460', boxShadow: '0 0 0 3px rgba(15,52,96,0.08)' })}
                  onBlur={e => Object.assign(e.target.style, { borderColor: '#e2e8f0', boxShadow: 'none' })}
                />
              </div>

              {/* Language — loops over state languages, value = lid */}
              <div style={s.fieldGroup}>
                <label style={s.label}>Language</label>
                {/* Use the NEW ref here */}
                <div style={s.userArea} ref={languageRef}>
                  <button style={{ ...s.userPill, minWidth: "200px", justifyContent: "space-between" }} onClick={() => setDropdown2Open(o => !o)}>
                    <span style={s.userName}>{selectedLangName ? selectedLangName : "Select a language"}</span>
                    <span>{dropdown2Open ? '▲' : '▼'}</span>
                  </button>

                  {dropdown2Open && (
                    <div style={s.dropdown2}>
                      {languages.map(lang => (
                        //<div key={lang.lid} style={s.dropdownDivider}>
                        <div key={lang.lid}>
                          {/* FIXED: Added arrow function wrapper */}
                          <button
                            onClick={() => { setSelectedLang(lang.lid); setDropdown2Open(false); setSelectedLangName(lang.language_name) }}
                            className="dropdown-item"
                            style={s.dropdownItem}
                          >
                            {lang.language_name}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Pickle file */}
              <div style={s.fieldGroup}>
                <label style={s.label}>Pickle File (.pkl)</label>
                <div style={s.fileArea}>
                  <input
                    type="file"
                    accept=".pkl,.pickle"
                    onChange={e => setPickleFile(e.target.files?.[0] ?? null)}
                    style={{ fontSize: 13, color: '#4a5568', width: '100%', cursor: 'pointer' }}
                  />
                  {pickleFile && (
                    <p style={s.fileName}>✓ {pickleFile.name}</p>
                  )}
                </div>
              </div>

              {/* Submit */}
              <button
                className="save-btn"
                style={{
                  ...s.saveBtn,
                  opacity: (!modelName.trim() || !selectedLang || !pickleFile) ? 0.5 : 1,
                  cursor: (!modelName.trim() || !selectedLang || !pickleFile) ? 'not-allowed' : 'pointer',
                }}
                onClick={handleSave}
                disabled={!modelName.trim() || !selectedLang || !pickleFile}
              >
                Upload & Save
              </button>

            </form>
          </div>
        </div>
      )}
      {/* TRAINING MODAL */}
      {showTrainModal && (
        <div style={s.overlay} onClick={() => setShowTrainModal(false)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalHeader}>
              <div>
                <h2 style={s.modalTitle}>Train New Model</h2>
                <p style={s.modalSub}>Select the directory containing your labeled training data.</p>
              </div>
              <button style={s.closeBtn} onClick={() => { setModelName(""); setShowTrainModal(false); }}>✕</button>
            </div>

            <form style={s.form} onSubmit={e => e.preventDefault()}>
              {/* Model Name */}
              <div style={s.fieldGroup}>
                <label style={s.label}>Model Name</label>
                <input
                  placeholder="e.g. Arabic-Sign-v1"
                  value={trainModelName}
                  onChange={e => setTrainModelName(e.target.value)}
                  style={s.input}
                />
              </div>

              {/* Replace the bottom button/status section of your showTrainModal with this snippet */}
              <div style={{ marginTop: '20px' }}>
                {!training ? (
                  <button
                    className="save-btn"
                    style={{
                      ...s.saveBtn,
                      opacity: (!trainModelName.trim()) ? 0.6 : 1,
                      cursor: (!trainModelName.trim()) ? 'not-allowed' : 'pointer',
                      backgroundColor: '#6366f1'
                    }}
                    onClick={handleTrainSubmit}
                    disabled={!trainModelName.trim()}
                  >
                    Start Training via Colab
                  </button>
                ) : (
                  <div style={{ background: '#f8fafc', padding: '15px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '13px', fontWeight: '500' }}>
                      <span style={{ color: '#4a5568' }}>
                        {trainingStatus === 'local-setup' && 'Waiting for Local Runtime connection in Colab...'}
                        {trainingStatus === 'training' && 'Model Training Engine Running...'}
                      </span>
                      <span style={{ color: '#6366f1' }}>{progress}%</span>
                    </div>

                    {/* Progress Track */}
                    <div style={{ width: '100%', height: '8px', background: '#e2e8f0', borderRadius: '999px', overflow: 'hidden' }}>
                      <div style={{ width: `${progress}%`, height: '100%', background: '#6366f1', transition: 'width 0.4s ease' }} />
                    </div>

                    <p style={{ fontSize: '11px', color: '#718096', marginTop: '6px', textAlign: 'center' }}>
                      Do not close this page or your Colab window during processing.
                    </p>
                  </div>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
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
              You are not the owner of one or more selected language. You can only merge/delete Languages that belong to you.
            </p>
            <button
              style={{ ...s.saveBtn, background: '#dc2626', marginTop: 8 }}
              onClick={() => setShowError(false)}
            >
              OK
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
              onClick={() => { setShowDeleteModal(false); handleDelete(modelDeleting?.mid, modelDeleting?.uid, modelDeleting?.model_file); }}
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
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 32px',
    height: '64px',
    background: '#ffffff',
    borderBottom: '1px solid #edf0f7',
    boxShadow: '0 1px 12px rgba(0,0,0,0.04)',
    position: 'sticky',
    top: 0,
    zIndex: 10,
  },
  navBrand: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  logo: {
    fontSize: '48px',
    color: '#e2b96f',
    marginBottom: '12px',
    display: 'block',
  },
  navName: {
    fontFamily: "'Playfair Display', serif",
    fontSize: '30px',
    fontWeight: 700,
    color: '#06066a',
    letterSpacing: '0.5px',
  },

  /* USER PILL */
  userArea: {
    position: 'relative',
  },
  userPill: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '6px 14px 6px 6px',
    background: '#f7f8fc',
    border: '1.5px solid #edf0f7',
    borderRadius: '100px',
    cursor: 'pointer',
    transition: 'border-color 0.2s',
  },
  avatar: {
    width: '30px',
    height: '30px',
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #1a1a2e, #0f3460)',
    color: '#e2b96f',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.5px',
    flexShrink: 0,
  },
  userName: {
    fontSize: '13.5px',
    fontWeight: 500,
    color: '#1a1a2e',
  },

  /* DROPDOWN */
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

  dropdown2: {
    position: 'absolute',
    top: 'calc(100%)',
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
  card: {
    cursor: 'pointer',
    transition: '0.2s ease',
  },

  cardHover: {
    transform: 'translateY(-4px)',
  },

  deleteBtn: {
    backgroundColor: 'rgb(215 50 50)',
    color: "white",
    border: "none",
    padding: "8px 12px",
    borderRadius: "6px",
    height: '30px',
    display: 'flex',
    width: '30px',
    justifyContent: 'center',
    alignItems: 'center',
    cursor: "pointer",
    transition: 'background 0.2s, transform 0.15s',
  },

  cardButtons: {
    display: "flex",
    justifyContent: "space-between",
    gap: "10px",
    marginTop: "12px"
  },


  /* MAIN */
  main: {
    padding: '40px 40px',
    maxWidth: '1100px',
    margin: '0 auto',
  },
  pageHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginBottom: '32px',
  },
  pageTitle: {
    fontFamily: "'Playfair Display', serif",
    fontSize: '32px',
    fontWeight: 600,
    color: '#1a1a2e',
    marginBottom: '4px',
  },
  pageSubtitle: {
    fontSize: '14px',
    color: '#a0aec0',
    fontWeight: 300,
  },
  addBtn: {
    padding: '12px 22px',
    background: '#1a1a2e',
    color: '#ffffff',
    border: 'none',
    borderRadius: '12px',
    fontSize: '14px',
    fontWeight: 500,
    cursor: 'pointer',
    letterSpacing: '0.3px',
    transition: 'background 0.2s, transform 0.15s',
    fontFamily: "'DM Sans', sans-serif",
    margin: '20px',
  },

  /* GRID */
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '24px',
  },
  card: {
    background: '#ffffff',
    borderRadius: '20px',
    padding: '28px',
    boxShadow: '0 2px 16px rgba(0,0,0,0.05)',
    position: 'relative',
    overflow: 'hidden',
    border: '1px solid #edf0f7',
  },
  cardAccent: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '3px',
    background: 'linear-gradient(90deg, #1a1a2e, #e2b96f)',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
  },
  cardIcon: {
    width: '44px',
    height: '44px',
    borderRadius: '12px',
    background: 'linear-gradient(135deg, #1a1a2e, #0f3460)',
    color: '#e2b96f',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '18px',
    fontWeight: 700,
    marginBottom: '16px',
    fontFamily: "'Playfair Display', serif",
  },
  cardTitle: {
    fontFamily: "'Playfair Display', serif",
    fontSize: '20px',
    fontWeight: 600,
    color: '#1a1a2e',
    marginBottom: '6px',
  },
  cardMeta: {
    fontSize: '12.5px',
    color: '#a0aec0',
    fontWeight: 300,
    marginBottom: '20px',
  },
  addDataBtn: {
    padding: '10px 18px',
    background: '#059669',
    color: '#ffffff',
    border: 'none',
    borderRadius: '10px',
    fontSize: '13.5px',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'background 0.2s',
    fontFamily: "'DM Sans', sans-serif",
  },

  /* MODAL */
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
  deleteBtn2: {
    padding: '13px', background: '#dc2626', color: '#ffffff',
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
  saveBtn: {
    padding: '14px',
    background: '#1a1a2e',
    color: '#ffffff',
    border: 'none',
    borderRadius: '12px',
    fontSize: '14.5px',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'background 0.2s',
    fontFamily: "'DM Sans', sans-serif",
  },
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(10,15,30,0.50)',
    backdropFilter: 'blur(6px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 50,
    animation: 'fadeIn 0.2s ease',
    padding: 24,
  },
  modal: {
    background: '#ffffff',
    borderRadius: 24,
    width: '100%', maxWidth: 440,
    padding: 32,
    boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
    animation: 'slideUp 0.25s ease',
  },
  modalHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
    marginBottom: 28,
  },
  modalTitle: {
    fontFamily: "'Playfair Display', serif",
    fontSize: 22, fontWeight: 600, color: '#1a1a2e', marginBottom: 4,
  },
  modalSub: {
    fontSize: 13, color: '#a0aec0', fontWeight: 300,
  },
  closeBtn: {
    width: 34, height: 34, borderRadius: '50%',
    border: 'none', background: '#f7f8fc',
    cursor: 'pointer', fontSize: 13, color: '#7a8499',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'background 0.2s', flexShrink: 0,
  },
  form: {
    display: 'flex', flexDirection: 'column', gap: 20,
  },
  fieldGroup: {
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  label: {
    fontSize: 13, fontWeight: 500, color: '#4a5568', letterSpacing: '0.3px',
  },
  input: {
    padding: '13px 16px',
    borderRadius: 12,
    border: '1.5px solid #e2e8f0',
    fontSize: 14,
    color: '#1a202c',
    background: '#fafbfc',
    transition: 'border-color 0.2s, box-shadow 0.2s',
    fontFamily: "'DM Sans', sans-serif",
    width: '100%',
  },
  // Use this for the <select> — merges with `input` so apply both
  select: {
    padding: '13px 16px',
    borderRadius: 13,
    border: '0.5px solid #e2e8f0',
    fontSize: 14,
    background: 'transparent',
    fontFamily: "'DM Sans', sans-serif",
    width: '100%',
    appearance: 'none',
    WebkitAppearance: 'none',
    backgroundPosition: 'right 16px center',
    paddingRight: 40,
    fontSize: '13.5px',
    color: '#4a5568',
    transition: 'background 0.15s, color 0.15s',
    cursor: 'pointer',
  },
  fileArea: {
    padding: '14px 16px',
    borderRadius: 12,
    border: '1.5px dashed #e2e8f0',
    background: '#fafbfc',
    cursor: 'pointer',
  },
  fileName: {
    marginTop: 8, fontSize: 12, color: '#059669',
  },
  saveBtn: {
    padding: 14,
    background: '#1a1a2e',
    color: '#ffffff',
    border: 'none',
    borderRadius: 12,
    fontSize: 14.5, fontWeight: 500,
    cursor: 'pointer',
    transition: 'background 0.2s',
    fontFamily: "'DM Sans', sans-serif",
    marginTop: 4,
  },

};
