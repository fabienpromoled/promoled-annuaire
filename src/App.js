import React, { useEffect, useMemo, useRef, useState } from "react";
import emailjs from "@emailjs/browser";

/** =========================
 *  PromoLED — Annuaire Électriciens
 *  v6.1 (complet, sans rating, sans démo)
 *  =========================
 *  - Login (front)
 *  - Public: recherche par photos / entreprises
 *      • Filtres par Tags: OR intra-groupe (Zones / Produits) + AND entre groupes
 *      • Filtrage géographique : serviceZips prioritaire > distance réelle (Haversine) si base CP importée > fallback département + rayon
 *      • Photos en grand, nom cliquable -> profil, bouton "Être contacté" (formulaire EmailJS)
 *  - Profil: présentation riche, galerie 2 colonnes, bouton "Être contacté"
 *  - Admin (PIN): créer/éditer/supprimer électriciens, uploader photos, tagger (recherche + toggle), gérer catalogue tags (ajout/suppression),
 *                 import/export JSON de l’annuaire, import CSV/JSON de la base CP (cp→lat,lng)
 *  - Pas de données de démo (annuaire initialement vide)
 *  ========================= */

// ---- Auth (front) ----
const AUTH_USER = "promoled";
const AUTH_PASS = "Promoled@2012";
const AUTH_KEY  = "pl_auth_ok";

// ---- EmailJS ----
const EMAILJS_SERVICE_ID = "service_e9tf34o";
const EMAILJS_TEMPLATE_ID = "template_0bbm6om";
const EMAILJS_PUBLIC_KEY  = "aY-YVm-wvBPVP06TX";

// ---- Thème / UI ----
const ADMIN_PIN = "2424";
const THEME = {
  primary: "#111827",
  accent: "#FFD100",
  bg: "#F8FAFC",
  card: "#FFFFFF",
  muted: "#6B7280",
};
const DEFAULT_ZONE_TAGS = ["Cuisine", "Salon", "Extérieur", "Couloir", "Salle de bain", "Chambre", "Bureau", "Commerce"];
const DEFAULT_PRODUCT_TAGS = ["Bande LED", "Projecteur", "Guirlande", "Profilé", "Ruban RGB", "CCT", "Spot encastré", "Néon Flex"];

const uid = () => Math.random().toString(36).slice(2, 9);
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const load = (k, fallback) => {
  try { const x = JSON.parse(localStorage.getItem(k)); return x ?? fallback; }
  catch { return fallback; }
};

/* ========= Géoloc CP → lat/lng + Haversine ========= */
const depOf = (cp) => (cp || "").toString().trim().slice(0,2);
const sameDept = (cpA, cpB) => depOf(cpA) && depOf(cpA) === depOf(cpB);

// distance en km
const haversineKm = (lat1, lon1, lat2, lon2) => {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon/2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// 1) serviceZips prioritaire
// 2) distance réelle si coords + rayon > 0
// 3) fallback: même département + rayon > 0
const servesCP = (userCP, electricianZip, radiusKm, cpIndex, serviceZips = []) => {
  if (!userCP) return true;
  const cp = (userCP || "").trim();

  if (serviceZips?.length && serviceZips.includes(cp)) return true;

  const a = cpIndex?.[electricianZip?.trim()];
  const b = cpIndex?.[cp];
  if (a && b && radiusKm > 0) {
    const d = haversineKm(a[0], a[1], b[0], b[1]);
    return d <= radiusKm;
  }

  if (!electricianZip) return false;
  if (!radiusKm || radiusKm <= 0) return false;
  return sameDept(electricianZip, cp);
};

/* ========= Store / Persistance + Base CP ========= */
const useDirectory = () => {
  // Annuaire vide par défaut (pas de démo)
  const [data, setData] = useState(() => load("pl_elec_directory", []));
  const [zoneTags, setZoneTags] = useState(() => load("pl_zone_tags", DEFAULT_ZONE_TAGS));
  const [productTags, setProductTags] = useState(() => load("pl_product_tags", DEFAULT_PRODUCT_TAGS));
  // Base CP: { "31000": [lat, lng], ... }
  const [cpIndex, setCpIndex] = useState(() => load("pl_cp_index", {}));

  useEffect(() => { save("pl_elec_directory", data); }, [data]);
  useEffect(() => { save("pl_zone_tags", zoneTags); }, [zoneTags]);
  useEffect(() => { save("pl_product_tags", productTags); }, [productTags]);
  useEffect(() => { save("pl_cp_index", cpIndex); }, [cpIndex]);

  const upsert = (elec) => {
    setData((prev) => {
      const i = prev.findIndex((e) => e.id === elec.id);
      if (i === -1) return [{ ...elec, updatedAt: Date.now() }, ...prev];
      const clone = [...prev];
      clone[i] = { ...elec, updatedAt: Date.now() };
      return clone;
    });
  };
  const remove = (id) => setData((prev) => prev.filter((e) => e.id !== id));
  const addPhoto = (id, photo) => setData((prev) => prev.map((e) => (e.id === id ? { ...e, photos: [{ id: uid(), ...photo }, ...(e.photos || [])] } : e)));
  const updatePhoto = (id, photoId, patch) => setData((prev) => prev.map((e) => (e.id === id ? { ...e, photos: e.photos.map((p) => (p.id === photoId ? { ...p, ...patch } : p)) } : e)));
  const deletePhoto = (id, photoId) => setData((prev) => prev.map((e) => (e.id === id ? { ...e, photos: e.photos.filter((p) => p.id !== photoId) } : e)));

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify({ data, zoneTags, productTags }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url;
    a.download = `promoled_annuaire_${new Date().toISOString().slice(0,10)}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  const importJSON = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        try {
          const parsed = JSON.parse(r.result);
          setData(parsed.data ?? []);
          setZoneTags(parsed.zoneTags ?? DEFAULT_ZONE_TAGS);
          setProductTags(parsed.productTags ?? DEFAULT_PRODUCT_TAGS);
          resolve(true);
        } catch (e) { reject(e); }
      };
      r.onerror = reject;
      r.readAsText(file);
    });

  // ===== Import base CP CSV/JSON =====
  const importCPBase = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        try {
          const txt = r.result.toString();
          let map = {};
          if (file.name.toLowerCase().endsWith(".json")) {
            const parsed = JSON.parse(txt);
            Object.entries(parsed).forEach(([cp, arr]) => {
              const lat = Number(arr[0]), lng = Number(arr[1]);
              if (/^\d{5}$/.test(cp) && Number.isFinite(lat) && Number.isFinite(lng)) map[cp] = [lat, lng];
            });
          } else {
            // CSV: cp;lat;lng (séparateur ; ou ,)
            const lines = txt.split(/\r?\n/).filter(Boolean);
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line) continue;
              if (i === 0 && /cp/i.test(line) && /lat/i.test(line) && /(lng|lon)/i.test(line)) continue; // ignore header
              const parts = line.split(/[;,]/).map(s => s.trim());
              if (parts.length < 3) continue;
              const cp = parts[0];
              const lat = Number(parts[1].replace(",", "."));
              const lng = Number(parts[2].replace(",", "."));
              if (/^\d{5}$/.test(cp) && Number.isFinite(lat) && Number.isFinite(lng)) map[cp] = [lat, lng];
            }
          }
          if (Object.keys(map).length === 0) throw new Error("Aucune donnée CP valide trouvée.");
          setCpIndex(map);
          resolve(true);
        } catch (e) { reject(e); }
      };
      r.onerror = reject;
      r.readAsText(file);
    });

  return { data, upsert, remove, addPhoto, updatePhoto, deletePhoto,
           zoneTags, setZoneTags, productTags, setProductTags,
           cpIndex, importCPBase, exportJSON, importJSON };
};

/* ========= UI helpers ========= */
const Chip = ({ active, onClick, kind, children }) => (
  <button className={`chip touch ${kind ? kind : ""} ${active ? "active" : ""}`} onClick={onClick}>
    {children}
  </button>
);
const Field = ({ label, children }) => (
  <label className="grid" style={{ gap: 6 }}>
    <span className="muted" style={{ fontSize:12 }}>{label}</span>
    {children}
  </label>
);
const PhotoInput = ({ onPick }) => {
  const ref = useRef();
  return (
    <div>
      <input type="file" accept="image/*" hidden ref={ref} onChange={async (e) => {
        const file = e.target.files?.[0]; if (!file) return;
        const url = await toDataURL(file); onPick(url); ref.current.value = "";
      }} />
      <button className="btn ghost touch" onClick={() => ref.current?.click()}>Ajouter une photo</button>
    </div>
  );
};
const toDataURL = (file) => new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(file); });

/* ========= TRI / Normalisation ========= */
const sortSelectedFirst = (list, selected) =>
  [...list].sort((a, b) => {
    const aSel = selected.includes(a), bSel = selected.includes(b);
    if (aSel && !bSel) return -1; if (!aSel && bSel) return 1;
    return a.localeCompare(b, "fr", { sensitivity: "base" });
  });
const norm = (s) => (s ?? "").toString().trim().toLowerCase();
const includesAny = (arr = [], selected = []) => {
  const set = new Set((arr || []).map(norm));
  return selected.some((t) => set.has(norm(t)));
};

/* ========= Editeur riche (présentation) ========= */
function RichTextEditor({ value, onChange }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && value !== undefined && value !== ref.current.innerHTML) {
      ref.current.innerHTML = value || "";
    }
  }, [value]);
  const exec = (cmd, val = null) => { document.execCommand(cmd, false, val); onChange(ref.current.innerHTML); };
  const applyBlock = (tag) => { document.execCommand("formatBlock", false, tag); onChange(ref.current.innerHTML); };
  const onInput = () => onChange(ref.current.innerHTML);
  return (
    <div className="grid" style={{ gap: 6 }}>
      <div style={{display:"flex",flexWrap:"wrap",gap:6,padding:6,border:"1px solid #E5E7EB",borderRadius:12,background:"#fff"}}>
        <select className="chip" onChange={(e)=>exec("fontName", e.target.value)} defaultValue="">
          <option value="" disabled>Police</option>
          <option>Arial</option><option>"Segoe UI"</option><option>Roboto</option><option>"Times New Roman"</option><option>Georgia</option><option>Tahoma</option>
        </select>
        <select className="chip" onChange={(e)=>exec("fontSize", e.target.value)} defaultValue="">
          <option value="" disabled>Taille</option>
          <option value="2">Petit</option><option value="3">Normal</option><option value="4">Grand</option><option value="5">XL</option>
        </select>
        <button className="chip" onClick={()=>applyBlock("H1")}>H1</button>
        <button className="chip" onClick={()=>applyBlock("H2")}>H2</button>
        <button className="chip" onClick={()=>applyBlock("P")}>Paragraphe</button>
        <button className="chip" onClick={()=>exec("bold")}><b>B</b></button>
        <button className="chip" onClick={()=>exec("italic")}><i>I</i></button>
        <button className="chip" onClick={()=>exec("underline")}><u>U</u></button>
        <button className="chip" onClick={()=>exec("strikeThrough")}>S</button>
        <button className="chip" onClick={()=>exec("insertUnorderedList")}>• Liste</button>
        <button className="chip" onClick={()=>exec("insertOrderedList")}>1. Liste</button>
        <button className="chip" onClick={()=>exec("justifyLeft")}>⟸</button>
        <button className="chip" onClick={()=>exec("justifyCenter")}>⇔</button>
        <button className="chip" onClick={()=>exec("justifyRight")}>⟹</button>
        <button className="chip" onClick={()=>exec("removeFormat")}>Effacer format</button>
      </div>
      <div ref={ref} onInput={onInput} contentEditable suppressContentEditableWarning className="input" style={{minHeight:120,lineHeight:1.4,overflowY:"auto",background:"#fff"}} placeholder="Votre présentation…" />
      <div className="muted" style={{ fontSize:11 }}>Sélectionnez du texte puis appliquez un style (B, I, H1, liste, etc.).</div>
    </div>
  );
}

/* ========= Public Directory ========= */
const PublicDirectory = ({ store, onOpenProfile }) => {
  const { data, zoneTags, productTags, cpIndex } = store;

  const [mode, setMode] = useState("photos"); // "photos" | "entreprises"
  const [userCP, setUserCP] = useState("");
  const [needPhotos, setNeedPhotos] = useState(false);
  const [zoneFilter, setZoneFilter] = useState([]);
  const [productFilter, setProductFilter] = useState([]);
  const [showOverlayFor, setShowOverlayFor] = useState(null);

  // ENTREPRISES: OR dans chaque groupe + AND entre groupes
  const filteredCompanies = useMemo(() => {
    return data.filter((e) => {
      const okGeo = servesCP(userCP, e.address?.zip, e.serviceRadiusKm ?? 0, cpIndex, e.serviceZips);
      if (!okGeo) return false;
      if (needPhotos && (!e.photos || e.photos.length === 0)) return false;
      const hasMatchingPhoto = (e.photos || []).some((p) => {
        const okZone = !zoneFilter.length || includesAny(p.zones || [], zoneFilter);
        const okProd = !productFilter.length || includesAny(p.products || [], productFilter);
        return okZone && okProd;
      });
      return hasMatchingPhoto;
    });
  }, [data, userCP, zoneFilter, productFilter, needPhotos, cpIndex]);

  // PHOTOS: OR/AND idem
  const filteredPhotos = useMemo(() => {
    const items = [];
    data.forEach((e) => {
      const okGeo = servesCP(userCP, e.address?.zip, e.serviceRadiusKm ?? 0, cpIndex, e.serviceZips);
      if (!okGeo) return;
      (e.photos || []).forEach((p) => {
        const okZone = !zoneFilter.length || includesAny(p.zones || [], zoneFilter);
        const okProd = !productFilter.length || includesAny(p.products || [], productFilter);
        if (okZone && okProd) items.push([e, p]);
      });
    });
    return items;
  }, [data, userCP, zoneFilter, productFilter, cpIndex]);

  // Modal contact (vue Photos)
  const [modalOpen, setModalOpen] = useState(false);
  const [targetElec, setTargetElec] = useState(null);
  const [targetPhoto, setTargetPhoto] = useState(null);
  const formRef = useRef(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const openContact = (elec, photo) => {
    setTargetElec(elec);
    setTargetPhoto(photo);
    setModalOpen(true);
    setSent(false);
    setError("");
  };

  const sanitize = (val, max = 400) => {
    let s = (val ?? "").toString();
    s = s.replace(/\u0000/g, "").replace(/[\u2028\u2029]/g, "\n").slice(0, max);
    return s;
  };

  const onSubmit = async (ev) => {
    ev.preventDefault();
    if (!formRef.current || !targetElec) return;

    const fd = new FormData(formRef.current);
    const requestDate = new Date().toLocaleString("fr-FR", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });

    const payload = {
      client_name: sanitize(fd.get("client_name"), 120),
      client_phone: sanitize(fd.get("client_phone"), 40),
      client_city: sanitize(fd.get("client_city"), 80),
      project_desc: sanitize(fd.get("project_desc"), 1200),
      spoken_with: sanitize(fd.get("spoken_with"), 80),
      electrician_name: sanitize(targetElec.company || targetElec.name, 120),
      electrician_email: sanitize(targetElec.email || "", 120),
      electrician_phone: sanitize(targetElec.phone || "", 40),
      electrician_city: sanitize(targetElec.address?.city || "", 80),
      electrician_zip: sanitize(targetElec.address?.zip || "", 10),
      request_date: requestDate,
    };

    try {
      setSending(true); setError("");
      await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, payload, { publicKey: EMAILJS_PUBLIC_KEY });
      setSent(true); formRef.current.reset();
    } catch (e) {
      setError(e?.text || e?.message || "Échec de l’envoi. Merci de réessayer.");
    } finally { setSending(false); }
  };

  return (
    <div className="container">
      <div className="card" style={{ display:"grid", gap:10 }}>
        <Field label="Mode de recherche">
          <div className="subtabs">
            <button className={`subtab touch ${mode==="photos" ? "active" : ""}`} onClick={()=>setMode("photos")}>Par photos</button>
            <button className={`subtab touch ${mode==="entreprises" ? "active" : ""}`} onClick={()=>setMode("entreprises")}>Par entreprise</button>
          </div>
        </Field>

        <Field label="Code postal">
          <input className="input touch" placeholder="ex: 31000" value={userCP} maxLength={5} onChange={(e)=>setUserCP(e.target.value.replace(/[^0-9]/g,''))} />
          <div className="muted" style={{ fontSize:11 }}>
            Distance réelle si la base CP est importée ; sinon, même département + rayon indiqué.
          </div>
        </Field>

        {/* Barre de tags (zones/produits) avec tri : sélectionnés d’abord puis alphabétique */}
        <div className="toolbar tags-bar">
          <span className="label">Zones :</span>
          {sortSelectedFirst(zoneTags, zoneFilter).map(t => (
            <Chip key={t} kind="zone" active={zoneFilter.includes(t)} onClick={() => setZoneFilter(prev => prev.includes(t) ? prev.filter(x=>x!==t) : [...prev, t])}>{t}</Chip>
          ))}
          <span className="label">Produits :</span>
          {sortSelectedFirst(productTags, productFilter).map(t => (
            <Chip key={t} kind="product" active={productFilter.includes(t)} onClick={() => setProductFilter(prev => prev.includes(t) ? prev.filter(x=>x!==t) : [...prev, t])}>{t}</Chip>
          ))}
        </div>

        {mode === "entreprises" && (
          <div className="toolbar">
            <Chip active={needPhotos} onClick={()=>setNeedPhotos(v=>!v)}>Avec photos</Chip>
          </div>
        )}
      </div>

      <div style={{ height:8 }} />

      {mode === "entreprises" ? (
        filteredCompanies.length === 0 ? (
          <div className="card muted">Aucun électricien ne correspond. Ajustez vos filtres ou importez la base CP en Admin.</div>
        ) : (
          <div className="grid" style={{ gap: 12 }}>
            {filteredCompanies.map(e => (
              <div key={e.id} className="card" onClick={()=>onOpenProfile(e)} style={{ display:"grid", gap:10 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <div>
                    <div style={{ fontWeight:800 }}>{e.company || e.name}</div>
                    <div className="muted" style={{ fontSize:12 }}>{e.address?.city} • {(e.specialties || []).slice(0,3).join(", ")} • Rayon {e.serviceRadiusKm ?? 0} km</div>
                  </div>
                </div>
                <div className="grid grid-2">
                  {(e.photos || []).slice(0,2).map(p => <img key={p.id} className="photo" src={p.dataUrl} alt="" />)}
                </div>
                {e.photos?.length ? <div className="muted" style={{ fontSize:12 }}>{e.photos.length} photo(s)</div> : <div className="muted" style={{ fontSize:12 }}>Pas encore de photos</div>}
                <button className="btn touch">Voir le profil</button>
              </div>
            ))}
          </div>
        )
      ) : (
        filteredPhotos.length === 0 ? (
          <div className="card muted">Aucune photo ne correspond. Ajustez vos filtres ou importez la base CP en Admin.</div>
        ) : (
          <div className="grid" style={{ gap: 12 }}>
            {filteredPhotos.map(([e, p]) => {
              const show = showOverlayFor === p.id;
              return (
                <div key={p.id} className={`photoCard ${show ? "" : "overlayHidden"}`} onClick={() => setShowOverlayFor(show ? null : p.id)}>
                  <img src={p.dataUrl} alt={p.caption || ""} />
                  <div className="photoOverlay">
                    <div onClick={(ev) => { ev.stopPropagation(); onOpenProfile(e); }} style={{ fontWeight:700, textDecoration:"underline", cursor:"pointer" }} title="Voir le profil">
                      {e.company || e.name}
                    </div>
                    <button className="btn warn touch" onClick={(ev) => { ev.stopPropagation(); openContact(e, p); }}>
                      Être contacté
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {/* MODAL: Être contacté (vue Photos) */}
      {modalOpen && targetElec && (
        <div className="modal-backdrop" onClick={()=>setModalOpen(false)}>
          <div className="modal" onClick={(e)=>e.stopPropagation()}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
              <div style={{ fontWeight:800 }}>Être contacté</div>
              <button className="btn ghost touch" onClick={()=>setModalOpen(false)}>Fermer</button>
            </div>
            <div className="muted" style={{ fontSize:12, marginBottom:8 }}>
              Électricien : <strong>{targetElec.company || targetElec.name}</strong>
            </div>
            {targetPhoto?.dataUrl ? (
              <div className="card" style={{ marginBottom: 8 }}>
                <img src={targetPhoto.dataUrl} alt="Photo chantier" className="photo" />
              </div>
            ) : null}
            <ContactForm formRef={formRef} sending={sending} sent={sent} error={error} onSubmit={onSubmit} />
          </div>
        </div>
      )}
    </div>
  );
};

/* ========= ContactForm (réutilisable) ========= */
function ContactForm({ formRef, sending, sent, error, onSubmit }) {
  return (
    <form ref={formRef} onSubmit={onSubmit} className="grid" style={{ gap:10 }}>
      <Field label="Nom & prénom">
        <input className="input touch" name="client_name" required placeholder="Votre nom" />
      </Field>
      <Field label="Numéro de téléphone">
        <input className="input touch" name="client_phone" required placeholder="06 xx xx xx xx" />
      </Field>
      <Field label="Ville">
        <input className="input touch" name="client_city" required placeholder="Votre ville" />
      </Field>
      <Field label="Description rapide du projet">
        <textarea className="input touch" name="project_desc" rows={3} placeholder="Ex: Bande LED cuisine, 4m, profilés alu…" />
      </Field>
      <Field label="J’ai parlé de ce projet avec (prénom)">
        <input className="input touch" name="spoken_with" placeholder="Prénom du conseiller" />
      </Field>

      {error && <div style={{ color:"#B91C1C" }}>{error}</div>}
      {sent ? (
        <div className="card" style={{ background:"#F0FDF4", borderColor:"#86EFAC" }}>
          Merci ! Votre demande a été envoyée.
        </div>
      ) : (
        <button className="btn touch" type="submit" disabled={sending}>
          {sending ? "Envoi…" : "Envoyer"}
        </button>
      )}
    </form>
  );
}

/* ========= Profil (2 colonnes, sans tags ni boutons appel/email) ========= */
const ProfileView = ({ elec, onBack }) => {
  const [modalOpen, setModalOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const formRef = useRef(null);

  const sanitize = (val, max = 400) => {
    let s = (val ?? "").toString();
    s = s.replace(/\u0000/g, "").replace(/[\u2028\u2029]/g, "\n").slice(0, max);
    return s;
  };
  const onSubmit = async (ev) => {
    ev.preventDefault();
    if (!formRef.current || !elec) return;
    const fd = new FormData(formRef.current);
    const requestDate = new Date().toLocaleString("fr-FR", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
    const payload = {
      client_name: sanitize(fd.get("client_name"), 120),
      client_phone: sanitize(fd.get("client_phone"), 40),
      client_city: sanitize(fd.get("client_city"), 80),
      project_desc: sanitize(fd.get("project_desc"), 1200),
      spoken_with: sanitize(fd.get("spoken_with"), 80),
      electrician_name: sanitize(elec.company || elec.name, 120),
      electrician_email: sanitize(elec.email || "", 120),
      electrician_phone: sanitize(elec.phone || "", 40),
      electrician_city: sanitize(elec.address?.city || "", 80),
      electrician_zip: sanitize(elec.address?.zip || "", 10),
      request_date: requestDate,
    };
    try {
      setSending(true); setError("");
      await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, payload, { publicKey: EMAILJS_PUBLIC_KEY });
      setSent(true); formRef.current.reset();
    } catch (e) {
      setError(e?.text || e?.message || "Échec de l’envoi. Merci de réessayer.");
    } finally { setSending(false); }
  };

  return (
    <div className="container">
      <div className="toolbar" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <button className="btn ghost touch" onClick={onBack}>← Retour</button>
        <button className="btn warn touch" onClick={() => { setModalOpen(true); setSent(false); setError(""); }}>Être contacté</button>
      </div>

      <div className="card" style={{ display:"grid", gap:10 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontWeight:800, fontSize:18 }}>{elec.company || elec.name}</div>
            <div className="muted" style={{ fontSize:12 }}>{elec.address?.street}, {elec.address?.zip} {elec.address?.city}</div>
          </div>
        </div>

        {elec.bioHtml
          ? <div style={{ fontSize:14, color:"#111827" }} dangerouslySetInnerHTML={{ __html: elec.bioHtml }} />
          : (elec.bio ? <div className="muted" style={{ fontSize:14 }}>{elec.bio}</div> : null)
        }

        <div className="chip">Rayon d’intervention : {elec.serviceRadiusKm ?? 0} km</div>

        <div className="divider" />

        {/* Galerie : 2 colonnes, images larges, sans tags */}
        <div className="grid grid-2" style={{ gap: 10 }}>
          {(elec.photos || []).map(p => (
            <figure key={p.id} style={{ margin:0 }}>
              <img src={p.dataUrl} alt={p.caption || ""} style={{ width:"100%", height:"auto", display:"block", borderRadius:16, border:"1px solid #E5E7EB" }} />
              {p.caption ? (<figcaption className="muted" style={{ fontSize:12, marginTop:6 }}>{p.caption}</figcaption>) : null}
            </figure>
          ))}
        </div>
      </div>

      {modalOpen && (
        <div className="modal-backdrop" onClick={()=>setModalOpen(false)}>
          <div className="modal" onClick={(e)=>e.stopPropagation()}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
              <div style={{ fontWeight:800 }}>Être contacté</div>
              <button className="btn ghost touch" onClick={()=>setModalOpen(false)}>Fermer</button>
            </div>
            <div className="muted" style={{ fontSize:12, marginBottom:8 }}>
              Électricien : <strong>{elec.company || elec.name}</strong>
            </div>
            <ContactForm formRef={formRef} sending={sending} sent={sent} error={error} onSubmit={onSubmit} />
          </div>
        </div>
      )}
    </div>
  );
};

/* ========= ProfileEditor ========= */
function ZipListEditor({ value = [], onChange }) {
  const [input, setInput] = useState("");
  const addZip = () => {
    const raw = input.trim(); if (!raw) return;
    const parts = raw.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    const valid = parts.filter(z => /^\d{5}$/.test(z));
    if (!valid.length) { setInput(""); return; }
    const next = Array.from(new Set([...(value || []), ...valid]));
    onChange(next); setInput("");
  };
  const removeZip = (z) => onChange((value || []).filter(x => x !== z));
  return (
    <div className="grid" style={{ gap:8 }}>
      <div style={{ display:"flex", gap:8 }}>
        <input className="input touch" placeholder="CP servis (ex: 31000, 31100)" value={input} onChange={(e)=>setInput(e.target.value)} onKeyDown={(e)=> e.key==="Enter" && addZip()} />
        <button className="btn ghost touch" onClick={addZip}>Ajouter</button>
      </div>
      <div className="toolbar" style={{ flexWrap:"wrap" }}>
        {(value || []).map(z => (<span key={z} className="chip touch" onClick={()=>removeZip(z)}>{z} ✕</span>))}
      </div>
      <div className="muted" style={{ fontSize:11 }}>Optionnel — prioritaire sur le rayon et la distance.</div>
    </div>
  );
}
function ProfileEditor({ value, onChange }) {
  const v = value || {};
  const patch = (p) => onChange({ ...v, ...p });
  const setAddr = (p) => onChange({ ...v, address: { ...(v.address || {}), ...p } });
  const setLoc  = (p) => onChange({ ...v, location: { ...(v.location || {}), ...p } });

  const [specInput, setSpecInput] = useState("");
  const addSpec = () => { const t = specInput.trim(); if (!t) return;
    const next = Array.from(new Set([...(v.specialties || []), t])); onChange({ ...v, specialties: next }); setSpecInput(""); };
  const removeSpec = (s) => onChange({ ...v, specialties: (v.specialties || []).filter(x => x !== s) });

  return (
    <div className="grid" style={{ gap:10 }}>
      <Field label="Nom / Raison sociale">
        <input className="input touch" value={v.company || ""} onChange={(e)=>patch({ company: e.target.value })} placeholder="Raison sociale" />
      </Field>

      <Field label="Présentation (mise en forme)">
        <RichTextEditor value={v.bioHtml || (v.bio ? `<p>${v.bio}</p>` : "")} onChange={(html) => patch({ bioHtml: html })} />
      </Field>

      <div className="grid grid-2">
        <Field label="Téléphone"><input className="input touch" value={v.phone || ""} onChange={(e)=>patch({ phone: e.target.value })} placeholder="05 xx xx xx xx" /></Field>
        <Field label="Email"><input className="input touch" value={v.email || ""} onChange={(e)=>patch({ email: e.target.value })} placeholder="contact@exemple.fr" /></Field>
      </div>

      <Field label="Site web">
        <input className="input touch" value={v.website || ""} onChange={(e)=>patch({ website: e.target.value })} placeholder="https://..." />
      </Field>

      <div className="grid grid-2">
        <Field label="Rue"><input className="input touch" value={v.address?.street || ""} onChange={(e)=>setAddr({ street: e.target.value })} /></Field>
        <Field label="Code postal (siège)"><input className="input touch" value={v.address?.zip || ""} onChange={(e)=>setAddr({ zip: e.target.value.replace(/[^0-9]/g,'').slice(0,5) })} /></Field>
      </div>

      {/* Ville — synchronise address.city + location.city */}
      <Field label="Ville">
        <input className="input touch"
          value={(typeof v.location?.city === "string" && v.location.city !== "") ? v.location.city : (v.address?.city || "")}
          onChange={(e) => { const city = e.target.value; setAddr({ city }); setLoc({ city }); }}
          placeholder="ex: Toulouse"
        />
      </Field>

      <div className="grid grid-2">
        <Field label="Département">
          <input className="input touch" value={v.location?.dept || ""} onChange={(e)=>setLoc({ dept: e.target.value })} placeholder="ex: 31" />
        </Field>
        <Field label="Rayon d’intervention (km)">
          <input className="input touch" type="number" min={0} step={5} value={v.serviceRadiusKm ?? 0} onChange={(e)=>patch({ serviceRadiusKm: Number(e.target.value) })} />
        </Field>
      </div>

      <Field label="Codes postaux servis (optionnel)">
        <ZipListEditor value={v.serviceZips || []} onChange={(list) => onChange({ ...v, serviceZips: list })} />
      </Field>

      <Field label="Spécialités (ex: Bande LED, Profilés…)">
        <div className="toolbar" style={{ flexWrap:"wrap" }}>
          {(v.specialties || []).map((s) => (<span key={s} className="chip touch" onClick={()=>removeSpec(s)}>{s} ✕</span>))}
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <input className="input touch" placeholder="Ajouter une spécialité" value={specInput} onChange={(e)=>setSpecInput(e.target.value)} onKeyDown={(e)=> e.key==="Enter" && addSpec()} />
          <button className="btn ghost touch" onClick={addSpec}>Ajouter</button>
        </div>
      </Field>
    </div>
  );
}

/* ========= TagPicker (catalogue + association avec recherche + toggle + suppression) ========= */
const TagPicker = ({ allTags, setAll, selected, onChange, placeholder, editableOnly }) => {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const normLocal = (s) => (s ?? "").toString().trim().toLowerCase();

  const matches = useMemo(() => {
    const key = normLocal(input);
    if (!key) return [];
    return allTags.filter(t => normLocal(t).startsWith(key)).slice(0, 8);
  }, [allTags, input]);

  const toggleSelect = (tag) => {
    if (editableOnly) return;
    const cur = selected || [];
    if (cur.includes(tag)) onChange(cur.filter(t => t !== tag));
    else { onChange([...cur, tag]); if (!allTags.includes(tag)) setAll([...allTags, tag]); }
  };

  const selectFromSuggest = (tag) => {
    if (editableOnly) { if (!allTags.includes(tag)) setAll([...allTags, tag]); }
    else toggleSelect(tag);
    setInput(""); setOpen(false); setHi(0);
  };

  const addNew = () => { const val = input.trim(); if (!val) return; selectFromSuggest(val); };

  const onKeyDown = (e) => {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) setOpen(true);
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((p) => Math.min(p + 1, Math.max(matches.length - 1, 0))); }
    if (e.key === "ArrowUp")   { e.preventDefault(); setHi((p) => Math.max(p - 1, 0)); }
    if (e.key === "Enter")     { e.preventDefault(); if (open && matches.length) selectFromSuggest(matches[hi]); else addNew(); }
    if (e.key === "Escape")    setOpen(false);
  };

  const removeFromSelected = (tag) => {
    if (editableOnly) return;
    onChange((selected || []).filter(t => t !== tag));
  };

  const removeFromCatalog = (tag) => {
    if (!editableOnly) return;
    if (confirm(`Supprimer le tag « ${tag} » du catalogue ?`)) {
      setAll(allTags.filter(t => t !== tag));
    }
  };

  return (
    <div className="grid" style={{ gap:8, position:"relative" }}>
      <div className="toolbar" style={{ flexWrap:"wrap" }}>
        {allTags.map(t => {
          const isSel = selected?.includes?.(t);
          return (
            <button
              key={t}
              className={`chip touch ${isSel ? "active" : ""}`}
              onClick={() => editableOnly ? null : toggleSelect(t)}
              title={editableOnly ? "Tag catalogue" : (isSel ? "Retirer de la photo" : "Associer à la photo")}
              style={{ position:"relative", paddingRight: editableOnly ? 26 : undefined }}
            >
              {t}{!editableOnly && isSel ? " ✓" : ""}
              {editableOnly && (
                <span
                  className="chip-x"
                  onClick={(e)=>{ e.stopPropagation(); removeFromCatalog(t); }}
                  title="Supprimer ce tag du catalogue"
                >✕</span>
              )}
            </button>
          );
        })}
      </div>

      <div style={{ display:"flex", gap:8, position:"relative" }}>
        <input
          className="input touch"
          placeholder={placeholder || "Rechercher ou créer un tag"}
          value={input}
          onChange={(e)=>{ setInput(e.target.value); setOpen(true); setHi(0); }}
          onFocus={()=> setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <button className="btn ghost touch" onClick={addNew}>Ajouter</button>

        {open && (matches.length > 0 || input.trim()) && (
          <div className="tag-suggest">
            {matches.map((m, idx) => (
              <div
                key={m}
                className={`tag-suggest-item ${idx === hi ? "hi" : ""}`}
                onMouseEnter={()=>setHi(idx)}
                onMouseDown={(e)=>{ e.preventDefault(); selectFromSuggest(m); }}
              >
                {m}
              </div>
            ))}
            {matches.length === 0 && input.trim() && (
              <div
                className="tag-suggest-item create"
                onMouseDown={(e)=>{ e.preventDefault(); addNew(); }}
              >
                Créer « {input.trim()} »
              </div>
            )}
          </div>
        )}
      </div>

      {!editableOnly && selected?.length > 0 && (
        <div className="toolbar" style={{ flexWrap:"wrap" }}>
          {(selected || []).map(t => (
            <span key={t} className="chip touch" onClick={()=>removeFromSelected(t)}>
              {t} ✕
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

/* ========= Admin ========= */
const Admin = ({ store }) => {
  const { data, upsert, remove, addPhoto, updatePhoto, deletePhoto,
          zoneTags, setZoneTags, productTags, setProductTags,
          cpIndex, importCPBase, exportJSON, importJSON } = store;

  const [editing, setEditing] = useState(null);
  const [pinOK, setPinOK] = useState(false);
  const [pinInput, setPinInput] = useState("");
  const [filterQ, setFilterQ] = useState("");

  const filteredList = useMemo(() => {
    const q = (filterQ || "").trim().toLowerCase();
    if (!q) return data;
    return data.filter((e) => {
      const hay = `${e.company || ""} ${e.name || ""} ${e.address?.city || ""} ${e.email || ""} ${e.phone || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [data, filterQ]);

  if (!pinOK) {
    return (
      <div className="container">
        <div className="card" style={{ display:"grid", gap:10 }}>
          <div style={{ fontWeight:800, fontSize:18 }}>Admin</div>
          <Field label="Code PIN">
            <input className="input touch" type="password" value={pinInput} onChange={(e)=>setPinInput(e.target.value)} />
          </Field>
          <button className="btn touch" onClick={()=>setPinOK(pinInput === ADMIN_PIN)}>Entrer</button>
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ display:"grid", gap:12 }}>
      <div className="card" style={{ display:"grid", gap:10 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div style={{ fontWeight:800 }}>
            Gestion de l’annuaire
            <span className="chip" style={{ marginLeft:8 }}>{filteredList.length} résultat{filteredList.length>1 ? "s" : ""}</span>
          </div>
          <div className="toolbar">
            <button className="btn ghost touch" onClick={()=>exportJSON()}>Exporter JSON</button>
            <label className="btn ghost touch" style={{ display:"inline-flex", alignItems:"center" }}>
              Importer JSON
              <input type="file" accept="application/json" hidden onChange={(e)=>{ const f=e.target.files?.[0]; if(f) importJSON(f); }} />
            </label>
            <button className="btn warn touch" onClick={()=>setEditing({ id: uid(), name:"", company:"", bio:"", bioHtml:"", address:{street:"",city:"",zip:""}, location:{city:"",dept:""}, specialties:[], serviceRadiusKm: 0, serviceZips: [], photos:[] })}>
              + Nouveau
            </button>
          </div>
        </div>

        {/* Filtre électricien */}
        <div className="card" style={{ display:"grid", gap:10 }}>
          <Field label="Rechercher un électricien">
            <div style={{ display:"flex", gap:8 }}>
              <input className="input touch" placeholder="Nom, société, ville, email, téléphone…" value={filterQ} onChange={(e)=>setFilterQ(e.target.value)} />
              {filterQ && (<button className="btn ghost touch" onClick={()=>setFilterQ("")}>Effacer</button>)}
            </div>
            <div className="muted" style={{ fontSize:12 }}>Saisie en temps réel — insensible à la casse.</div>
          </Field>
        </div>

        {/* Liste */}
        <div className="grid" style={{ gap:8 }}>
          {filteredList.map(e => (
            <div key={e.id} className="card" style={{ display:"grid", gap:8 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div>
                  <div style={{ fontWeight:700 }}>{e.company || e.name}</div>
                  <div className="muted" style={{ fontSize:12 }}>{e.address?.city} • {(e.specialties||[]).join(", ")} • Rayon {e.serviceRadiusKm ?? 0} km</div>
                </div>
                <div className="toolbar">
                  <button className="btn ghost touch" onClick={()=>setEditing(e)}>Éditer</button>
                  <button className="btn ghost touch" onClick={()=>remove(e.id)}>Supprimer</button>
                </div>
              </div>

              <div className="grid grid-2">
                {(e.photos || []).map(p => (
                  <div key={p.id} className="card" style={{ padding:8 }}>
                    <img src={p.dataUrl} alt="" className="photo" />
                    <div style={{ height:6 }} />
                    <Field label="Légende"><input className="input touch" value={p.caption || ""} onChange={(ev)=>updatePhoto(e.id, p.id, { caption: ev.target.value })} /></Field>
                    <Field label="Zones"><TagPicker allTags={zoneTags} setAll={setZoneTags} selected={p.zones || []} onChange={(v)=>updatePhoto(e.id, p.id, { zones: v })} placeholder="Rechercher/ajouter une zone" /></Field>
                    <Field label="Produits"><TagPicker allTags={productTags} setAll={setProductTags} selected={p.products || []} onChange={(v)=>updatePhoto(e.id, p.id, { products: v })} placeholder="Rechercher/ajouter un produit" /></Field>
                    <button className="btn ghost touch" onClick={()=>deletePhoto(e.id, p.id)}>Supprimer la photo</button>
                  </div>
                ))}
              </div>

              <PhotoInput onPick={(dataUrl)=>addPhoto(e.id, { dataUrl, zones: [], products: [], caption: "" })} />
            </div>
          ))}
        </div>
      </div>

      {/* Édition */}
      {editing && (
        <div className="card" style={{ display:"grid", gap:10 }}>
          <div style={{ fontWeight:800 }}>Éditer le profil</div>
          <ProfileEditor value={editing} onChange={setEditing} />
          <div className="toolbar">
            <button className="btn touch" onClick={()=>{ upsert(editing); setEditing(null); }}>Enregistrer</button>
            <button className="btn ghost touch" onClick={()=>setEditing(null)}>Annuler</button>
          </div>
        </div>
      )}

      {/* Gestion tags */}
      <div className="card" style={{ display:"grid", gap:10 }}>
        <div style={{ fontWeight:800 }}>Gestion des tags</div>
        <Field label="Tags de zones (ex: Cuisine, Salon…)">
          <TagPicker allTags={zoneTags} setAll={setZoneTags} selected={[]} onChange={()=>{}} editableOnly placeholder="Rechercher/ajouter une zone" />
        </Field>
        <Field label="Tags produits (ex: Bande LED, Projecteur…)">
          <TagPicker allTags={productTags} setAll={setProductTags} selected={[]} onChange={()=>{}} editableOnly placeholder="Rechercher/ajouter un produit" />
        </Field>
      </div>

      {/* Base codes postaux */}
      <div className="card" style={{ display:"grid", gap:10 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div style={{ fontWeight:800 }}>Base codes postaux (CP → lat,lng)</div>
          <span className="chip">{Object.keys(cpIndex || {}).length} CP</span>
        </div>
        <div className="muted" style={{ fontSize:12 }}>
          Importez un fichier <strong>CSV</strong> <code>cp;lat;lng</code> (ou <strong>JSON</strong> <code>{"{ \"31000\":[43.6045,1.4442], ... }"}</code>).
        </div>
        <div className="toolbar">
          <label className="btn ghost touch" style={{ display:"inline-flex", alignItems:"center" }}>
            Importer CSV / JSON
            <input type="file" accept=".csv, text/csv, application/json, .json" hidden onChange={(e)=>{ const f=e.target.files?.[0]; if (f) importCPBase(f).catch(err=>alert(err.message || String(err))); }} />
          </label>
          <button className="btn ghost touch" onClick={()=>alert("Format CSV attendu :\\ncp;lat;lng\\n31000;43.6045;1.4442\\n32000;43.6462;0.5849")}>
            Voir format attendu
          </button>
        </div>
      </div>
    </div>
  );
};

/* ========= AppShell / Styles ========= */
const AppShell = ({ children, onLogout }) => (
  <div style={{ fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif", background: THEME.bg, minHeight: "100vh", color: THEME.primary }}>
    <style>{`
      * { box-sizing: border-box; } button { cursor: pointer; }
      .container { max-width: 480px; margin: 0 auto; padding: 12px; }
      .brand { display:flex; align-items:center; gap:10px; }
      .logo { width:36px; height:36px; border-radius:8px; background:${THEME.accent}; display:flex; align-items:center; justify-content:center; font-weight:800; }
      .title { font-size:20px; font-weight:800; letter-spacing:.3px; }
      .muted { color:${THEME.muted}; }
      .card { background:${THEME.card}; border:1px solid #E5E7EB; border-radius:16px; padding:12px; }
      .chip { display:inline-flex; align-items:center; gap:6px; padding:6px 10px; border-radius:999px; border:1px solid #E5E7EB; background:#fff; font-size:12px; }
      .chip.active { border-color:${THEME.primary}; }
      .btn { background:${THEME.primary}; color:#fff; padding:10px 14px; border:none; border-radius:12px; font-weight:600; }
      .btn.ghost { background:#fff; color:${THEME.primary}; border:1px solid #E5E7EB; }
      .btn.warn { background:${THEME.accent}; color:#000; }
      .input, select, textarea { width:100%; padding:10px 12px; border-radius:12px; border:1px solid #E5E7EB; outline:none; }
      .grid { display:grid; gap:12px; }
      .grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .photo { width:100%; aspect-ratio:1/1; background:#F3F4F6; border-radius:12px; object-fit:cover; }
      .toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
      .tabs { display:flex; gap:8px; background:#fff; border:1px solid #E5E7EB; padding:6px; border-radius:12px; }
      .tab { flex:1; text-align:center; padding:8px; border-radius:8px; font-weight:600; }
      .tab.active { background:${THEME.primary}; color:#fff; }
      .subtabs { display:flex; gap:8px; margin-top:8px; }
      .subtab { flex:1; text-align:center; padding:8px; border-radius:999px; border:1px solid #E5E7EB; font-weight:600; background:#fff; }
      .subtab.active { background:${THEME.accent}; color:${THEME.primary}; }
      .divider { height:1px; background:#E5E7EB; margin:8px 0; }
      .touch { min-height:44px; }
      .badge { background:${THEME.accent}; color:${THEME.primary}; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; }

      .modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.5); display:flex; align-items:center; justify-content:center; padding:16px; z-index:50; overflow-y:auto; -webkit-overflow-scrolling:touch; }
      .modal { background:#fff; border-radius:16px; padding:16px; width:100%; max-width:460px; border:1px solid #E5E7EB; max-height:90vh; overflow-y:auto; -webkit-overflow-scrolling:touch; }

      .photoCard { position:relative; overflow:hidden; border-radius:16px; border:1px solid #E5E7EB; }
      .photoCard img { width:100%; height:auto; display:block; border-radius:16px; }
      .photoOverlay { position:absolute; left:0; right:0; bottom:0; background:linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,.6) 70%); color:#fff; padding:12px; display:flex; justify-content:space-between; align-items:end; }
      .overlayHidden .photoOverlay { display:none; }

      .tags-bar .chip { font-size:11px; padding:6px 10px; }
      .tags-bar .label { margin:0 6px 0 2px; font-size:12px; color:#6B7280; }
      .chip.zone { background:#E6F4EA; border-color:#B7E0C2; color:#0B6B3A; }
      .chip.zone.active { border-color:#0B6B3A; }
      .chip.product { background:#E8F0FE; border-color:#B6CCFE; color:#1E40AF; }
      .chip.product.active { border-color:#1E40AF; }

      .tag-suggest { position:absolute; top:100%; left:0; margin-top:4px; width:100%; max-height:220px; overflow-y:auto; border:1px solid #E5E7EB; background:#fff; border-radius:12px; box-shadow:0 6px 20px rgba(0,0,0,0.06); z-index:10; }
      .tag-suggest-item { padding:10px 12px; font-size:14px; cursor:pointer; }
      .tag-suggest-item.hi { background:#F3F4F6; }
      .tag-suggest-item.create { font-weight:600; }

      .chip-x { position:absolute; right:8px; top:50%; transform:translateY(-50%); font-weight:700; opacity:.7; padding:0 4px; border-radius:6px; }
      .chip-x:hover { opacity:1; background:#F3F4F6; }

      .login-wrap { min-height: 100vh; display:flex; align-items:center; justify-content:center; padding:20px; }
      .login-card { width:100%; max-width:380px; }
    `}</style>
    <header className="container" style={{ display:"flex", alignItems:"center", justifyContent:"space-between", paddingTop:10 }}>
      <div className="brand">
        <div className="logo">PL</div>
        <div>
          <div className="title">PromoLED</div>
          <div className="muted" style={{ fontSize:12 }}>Annuaire d’électriciens</div>
        </div>
      </div>
      <div className="toolbar" style={{ display:"flex", gap:8, alignItems:"center" }}>
        <div className="badge">Tactile</div>
        {onLogout ? <button className="btn ghost touch" onClick={onLogout}>Se déconnecter</button> : null}
      </div>
    </header>
    {children}
    <footer className="container" style={{ paddingBottom:24, paddingTop:4, fontSize:12 }} className="muted">
      © {new Date().getFullYear()} PromoLED — MVP
    </footer>
  </div>
);

/* ========= Login ========= */
function LoginScreen({ onSuccess }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState("");
  const submit = (e) => {
    e?.preventDefault();
    if (u === AUTH_USER && p === AUTH_PASS) { sessionStorage.setItem(AUTH_KEY, "1"); onSuccess(); }
    else setErr("Identifiants invalides.");
  };
  return (
    <div className="login-wrap" style={{ background: THEME.bg }}>
      <div className="card login-card">
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
          <div className="logo">PL</div>
          <div style={{ fontWeight:800, fontSize:18 }}>Connexion PromoLED</div>
        </div>
        <form onSubmit={submit} className="grid" style={{ gap:10 }}>
          <label className="grid" style={{ gap:6 }}>
            <span className="muted" style={{ fontSize:12 }}>Utilisateur</span>
            <input className="input touch" value={u} onChange={(e)=>setU(e.target.value)} placeholder="Utilisateur" autoFocus />
          </label>
          <label className="grid" style={{ gap:6 }}>
            <span className="muted" style={{ fontSize:12 }}>Mot de passe</span>
            <input className="input touch" type="password" value={p} onChange={(e)=>setP(e.target.value)} placeholder="Mot de passe" />
          </label>
          {err && <div style={{ color:"#B91C1C" }}>{err}</div>}
          <button className="btn touch" type="submit">Se connecter</button>
        </form>
        <div className="muted" style={{ fontSize:11, marginTop:8 }}>
          La session reste ouverte jusqu’à fermeture de l’onglet.
        </div>
      </div>
    </div>
  );
}

/* ========= Racine ========= */
export default function App() {
  const authedInitially = typeof window !== "undefined" && sessionStorage.getItem(AUTH_KEY) === "1";
  const [isAuthed, setIsAuthed] = useState(authedInitially);

  const store = useDirectory();
  const [tab, setTab] = useState("public");
  const [open, setOpen] = useState(null);

  if (!isAuthed) {
    return <LoginScreen onSuccess={() => setIsAuthed(true)} />;
  }

  const handleLogout = () => {
    sessionStorage.removeItem(AUTH_KEY);
    setIsAuthed(false);
  };

  return (
    <AppShell onLogout={handleLogout}>
      <div className="container" style={{ paddingTop: 8 }}>
        <div className="tabs">
          <button className={`tab touch ${tab==="public" ? "active" : ""}`} onClick={()=>{ setTab("public"); setOpen(null); }}>Trouver un électricien</button>
          <button className={`tab touch ${tab==="admin" ? "active" : ""}`} onClick={()=>{ setTab("admin"); setOpen(null); }}>Admin</button>
        </div>
      </div>

      {tab === "public" && (open
        ? <ProfileView elec={open} onBack={()=>setOpen(null)} />
        : <PublicDirectory store={store} onOpenProfile={(e)=>setOpen(e)} />
      )}

      {tab === "admin" && <Admin store={store} />}
    </AppShell>
  );
}
