"use strict";
/* English Quest — moteur de l'appli.
   Principes (voir ETUDES.md) : pratique de récupération + correction immédiate, répétition espacée
   (modèle de « demi-vie » de la mémoire), passage progressif de la reconnaissance à la production,
   révisions entremêlées, mini-leçons explicites, vocabulaire le plus fréquent, audio, gamification. */

// ------------------------------------------------------------------ utilitaires
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const md = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\*(.+?)\*/g, "<i>$1</i>").replace(/\n/g, "<br>");
const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = a => a[Math.floor(Math.random() * a.length)];
const JOUR = 86400000;
const dateStr = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const aujourdhui = () => dateStr(Date.now());
const hier = () => dateStr(Date.now() - JOUR);

let API = null, MONDES = [], LECONS = [], PACKS = [], VOCAB = [], VBYID = {}, PROG = null, SESSION = null;
let VPACKS = [], VERBES = [], IBYID = {};   // verbes irréguliers
let HISTOIRES = [], CINE = [];
let gestionTouches = null;
document.addEventListener("keydown", e => gestionTouches && gestionTouches(e));

const progDefaut = () => ({
  version: 3, xp: 0, serie: 0, meilleureSerie: 0, dernierJour: null, jours: {}, objectif: 50, son: true,
  items: {}, lecons: {}, badges: [], stats: { bonnes: 0, mauvaises: 0, sessions: 0, meilleurCombo: 0 },
  gels: 1, joursObjectif: 0, histoires: {}, scenes: {}, rappel: null, voixNaturelle: true, sessionJour: null,
});

// ------------------------------------------------------------------ sauvegarde
let minuteurSauvegarde = null;
function sauver() {
  clearTimeout(minuteurSauvegarde);
  minuteurSauvegarde = setTimeout(() => {
    if (API) API.sauver(PROG);
    else try { localStorage.setItem("englishquest", JSON.stringify(PROG)); } catch (e) { /* stockage indisponible */ }
    planifierSync();
  }, 250);
}

// ------------------------------------------------------------------ synchronisation PC ↔ iPhone (Supabase)
// Table « progression » (user_id, data, updated_at) protégée par RLS : chacun ne voit que sa propre ligne.
// La clé « anon » est publique par conception ; la sécurité repose sur la connexion et les règles RLS.
const CLOUD = { url: (window.EQ_CONFIG?.supabaseUrl || "").replace(/\/$/, ""), cle: window.EQ_CONFIG?.supabaseKey || "" };
const cloudConfigure = () => !!(CLOUD.url && CLOUD.cle);
let COMPTE = null;                       // { email, user_id, access_token, refresh_token, expires_at }
let etatSync = { statut: "off", derniere: null, message: "" };   // off | ok | encours | erreur
let minuteurSync = null;

async function lireCompte() {
  try { return API ? await API.lireCompte() : JSON.parse(localStorage.getItem("eq_compte") || "null"); } catch (e) { return null; }
}
async function ecrireCompte(c) {
  COMPTE = c;
  try { if (API) await API.ecrireCompte(c); else if (c) localStorage.setItem("eq_compte", JSON.stringify(c)); else localStorage.removeItem("eq_compte"); } catch (e) { /* rien */ }
}
async function appelCloud(chemin, options = {}) {
  const entetes = { apikey: CLOUD.cle, "Content-Type": "application/json", ...(options.headers || {}) };
  if (COMPTE?.access_token && !options.sansJeton) entetes.Authorization = "Bearer " + COMPTE.access_token;
  const r = await fetch(CLOUD.url + chemin, { method: options.method || "GET", headers: entetes, keepalive: !!options.keepalive,
    body: options.body ? JSON.stringify(options.body) : undefined });
  const texte = await r.text();
  let donnees = null;
  try { donnees = texte ? JSON.parse(texte) : null; } catch (e) { donnees = texte; }
  if (!r.ok) {
    const msg = donnees?.msg || donnees?.error_description || donnees?.message || donnees?.error || `Erreur ${r.status}`;
    throw Object.assign(new Error(msg), { statut: r.status });
  }
  return donnees;
}
function enregistrerSession(s) {
  return ecrireCompte({ email: s.user?.email || COMPTE?.email, user_id: s.user?.id || COMPTE?.user_id,
    access_token: s.access_token, refresh_token: s.refresh_token, expires_at: Date.now() + (s.expires_in || 3600) * 1000 - 60000 });
}
async function jetonValide() {
  if (!COMPTE) return false;
  if (Date.now() < COMPTE.expires_at) return true;
  const s = await appelCloud("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: COMPTE.refresh_token }, sansJeton: true });
  await enregistrerSession(s);
  return true;
}
const traduireErreur = m => /invalid login|invalid credentials/i.test(m) ? "E-mail ou mot de passe incorrect."
  : /already registered|already exists/i.test(m) ? "Un compte existe déjà avec cet e-mail : utilise « Se connecter »."
  : /password should be at least|weak/i.test(m) ? "Mot de passe trop court (6 caractères minimum)."
  : /email not confirmed/i.test(m) ? "Confirme d'abord ton adresse e-mail (lien reçu par e-mail)."
  : /failed to fetch|networkerror|load failed/i.test(m) ? "Pas de connexion Internet."
  : m;
async function connexion(email, motDePasse, creer) {
  const s = await appelCloud(creer ? "/auth/v1/signup" : "/auth/v1/token?grant_type=password",
    { method: "POST", body: { email, password: motDePasse }, sansJeton: true });
  if (!s.access_token) return { confirmer: true };   // confirmation par e-mail activée côté Supabase
  await enregistrerSession(s);
  // Appareil partagé : si la progression locale appartient à un AUTRE compte, on ne la mélange surtout pas.
  // (Une progression sans propriétaire, jamais synchronisée, est en revanche envoyée sur le compte qui se connecte.)
  if (PROG.proprietaire && PROG.proprietaire !== COMPTE.user_id) PROG = progressionVide();
  await synchroniser(true);
  return { ok: true };
}
function progressionVide() {   // repart de zéro en gardant les réglages propres à l'appareil
  return Object.assign(progDefaut(), { son: PROG.son, voixNaturelle: PROG.voixNaturelle, objectif: PROG.objectif, rappel: PROG.rappel, version: 3 });
}
async function deconnexion() {
  // la progression est d'abord mise à l'abri en ligne ; en cas d'échec, on ne déconnecte pas pour ne rien perdre
  if (COMPTE && !(await synchroniser())) return false;
  try { if (COMPTE) await appelCloud("/auth/v1/logout", { method: "POST" }); } catch (e) { /* tant pis */ }
  await ecrireCompte(null);
  etatSync = { statut: "off", derniere: null, message: "" };
  PROG = progressionVide();   // l'appareil est libéré pour un autre compte
  if (API) API.sauver(PROG); else try { localStorage.setItem("englishquest", JSON.stringify(PROG)); } catch (e) { /* rien */ }
  return true;
}

// Fusion de deux progressions : on garde toujours le meilleur des deux, rien ne se perd.
function fusionner(a, b) {
  if (!b) return a;
  if (!a) return b;
  const m = { ...b, ...a };
  const maxObj = (x = {}, y = {}) => { const r = { ...x }; for (const k in y) r[k] = Math.max(r[k] || 0, y[k] || 0); return r; };
  m.items = { ...b.items };
  for (const [id, s] of Object.entries(a.items || {})) {
    const t = m.items[id];
    m.items[id] = !t || s.n > t.n || (s.n === t.n && s.t >= t.t) ? s : t;
  }
  m.xp = Math.max(a.xp || 0, b.xp || 0);
  m.jours = maxObj(a.jours, b.jours);
  m.stats = maxObj(a.stats, b.stats);
  const recent = (a.dernierJour || "") >= (b.dernierJour || "") ? a : b;   // la série suit l'appareil le plus récent
  m.dernierJour = recent.dernierJour; m.serie = recent.serie; m.gels = recent.gels;
  m.meilleureSerie = Math.max(a.meilleureSerie || 0, b.meilleureSerie || 0);
  m.joursObjectif = Math.max(a.joursObjectif || 0, b.joursObjectif || 0);
  m.recordChrono = Math.max(a.recordChrono || 0, b.recordChrono || 0);
  m.faiblesCorriges = Math.max(a.faiblesCorriges || 0, b.faiblesCorriges || 0);
  m.sessionJour = [a.sessionJour, b.sessionJour].filter(Boolean).sort().pop() || null;
  m.badges = [...new Set([...(a.badges || []), ...(b.badges || [])])];
  m.lecons = { ...b.lecons };
  for (const [i, l] of Object.entries(a.lecons || {})) {
    const t = m.lecons[i] || {};
    m.lecons[i] = { etoiles: Math.max(l.etoiles || 0, t.etoiles || 0), tentatives: Math.max(l.tentatives || 0, t.tentatives || 0), parties: maxObj(l.parties, t.parties) };
  }
  const meilleur = (x = {}, y = {}, champ) => { const r = { ...y }; for (const k in x) if (!r[k] || (x[k][champ] || 0) >= (r[k][champ] || 0)) r[k] = x[k]; return r; };
  m.histoires = meilleur(a.histoires, b.histoires, "score");
  m.scenes = meilleur(a.scenes, b.scenes, "connues");
  m.paliers = { ...b.paliers };
  for (const [n, d] of Object.entries(a.paliers || {})) if (!m.paliers[n] || d < m.paliers[n]) m.paliers[n] = d;
  m.suivi = { ...b.suivi };
  for (const [j, s] of Object.entries(a.suivi || {})) if (!m.suivi[j] || s.acquis >= m.suivi[j].acquis) m.suivi[j] = s;
  // les réglages (son, voix, objectif, rappel) restent propres à chaque appareil : ceux de « a » (local) priment
  return m;
}
function planifierSync(delai = 15000) {
  if (!COMPTE || !cloudConfigure()) return;
  clearTimeout(minuteurSync);
  minuteurSync = setTimeout(() => synchroniser(), delai);
}
let syncEnCours = null;
async function synchroniser(rafraichir = false, keepalive = false) {
  if (!COMPTE || !cloudConfigure()) return false;
  if (syncEnCours) return syncEnCours;
  clearTimeout(minuteurSync);
  syncEnCours = (async () => {
    etatSync.statut = "encours"; majIndicateurSync();
    try {
      await jetonValide();
      const lignes = await appelCloud(`/rest/v1/progression?select=data&user_id=eq.${COMPTE.user_id}`);
      const distant = lignes?.[0]?.data || null;
      const avant = JSON.stringify(PROG);
      PROG = fusionner(PROG, distant);
      PROG.proprietaire = COMPTE.user_id;   // cette progression appartient désormais à ce compte
      await appelCloud("/rest/v1/progression", { method: "POST", keepalive,
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: { user_id: COMPTE.user_id, data: PROG, updated_at: new Date().toISOString() } });
      try { await publierClassement(keepalive); } catch (e) { /* classement pas encore activé ou hors ligne : sans gravité */ }
      if (JSON.stringify(PROG) !== avant) {
        if (API) API.sauver(PROG); else try { localStorage.setItem("englishquest", JSON.stringify(PROG)); } catch (e) { /* rien */ }
        if (rafraichir && $(".hero")) accueil();
      }
      etatSync = { statut: "ok", derniere: Date.now(), message: "" };
      return true;
    } catch (e) {
      etatSync = { statut: "erreur", derniere: etatSync.derniere, message: traduireErreur(e.message) };
      if (e.statut === 401 || e.statut === 400 && /refresh/i.test(e.message)) await ecrireCompte(null);   // session expirée
      return false;
    } finally {
      syncEnCours = null;
      majIndicateurSync();
    }
  })();
  return syncEnCours;
}
// ------------------------------------------------------------------ classement par groupe privé
// Table « classement » : une ligne publique par joueur (pseudo, avatar, scores), visible seulement par son groupe.
const AVATARS = ["🦊", "🐼", "🦁", "🐯", "🐸", "🐧", "🦉", "🐙", "🦄", "🐲", "🐢", "🐝", "🚀", "⚽", "🎮", "🎸", "🌸", "🌻", "👑", "🧙"];
function lundiDeLaSemaine(t = Date.now()) { const d = new Date(t); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return dateStr(d); }
function xpSemaine() { const l = lundiDeLaSemaine(); return Object.entries(PROG.jours).filter(([j]) => j >= l).reduce((t, [, x]) => t + x, 0); }
function nouveauCodeGroupe() {
  const lettres = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // sans 0/O ni 1/I, pour éviter les confusions
  return "EQ-" + Array.from(crypto.getRandomValues(new Uint8Array(6)), b => lettres[b % lettres.length]).join("");
}
function ligneClassement() {
  const vise = prochainNiveau();
  return { user_id: COMPTE.user_id, groupe: PROG.profil.groupe, pseudo: PROG.profil.pseudo, avatar: PROG.profil.avatar,
    niveau: niveauActuel() || "Pré-A1", avancement: vise ? Math.round(100 * avancement(vise)) : 100, xp: PROG.xp,
    xp_semaine: xpSemaine(), semaine: lundiDeLaSemaine(), serie: serieActuelle(), mots: VOCAB.filter(v => motAcquis(v.id)).length,
    connus: Object.values(PROG.items).filter(s => s.s >= 3).length, lecons: nbLeconsFaites(), updated_at: new Date().toISOString() };
}
async function publierClassement(keepalive = false) {
  if (!COMPTE || !PROG.profil?.groupe) return;
  await appelCloud("/rest/v1/classement", { method: "POST", keepalive,
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: ligneClassement() });
}
async function lireClassement() {
  await jetonValide();
  const lignes = await appelCloud("/rest/v1/classement?select=*");
  const semaine = lundiDeLaSemaine();
  return (lignes || []).map(l => ({ ...l, xp_semaine: l.semaine === semaine ? l.xp_semaine : 0 }));   // semaine terminée = remise à zéro
}
async function quitterGroupe() {
  try { await jetonValide(); await appelCloud(`/rest/v1/classement?user_id=eq.${COMPTE.user_id}`, { method: "DELETE" }); } catch (e) { /* rien */ }
  delete PROG.profil.groupe;
  sauver();
}

function majIndicateurSync() {
  const el = $("#indic-sync");
  if (!el) return;
  const s = !COMPTE ? "off" : etatSync.statut;
  el.textContent = { off: "", ok: "☁️", encours: "⏳", erreur: "⚠️" }[s] || "";
  el.title = { ok: "Progression synchronisée", encours: "Synchronisation…", erreur: "Synchronisation impossible : " + etatSync.message }[s] || "";
  el.style.display = s === "off" ? "none" : "";
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && COMPTE) synchroniser(false, true); });

// ------------------------------------------------------------------ sons (Web Audio)
let AC = null;
function note(f, t0, d, type = "sine", vol = 0.14) {
  try {
    AC = AC || new (window.AudioContext || window.webkitAudioContext)();
    if (AC.state === "suspended") AC.resume();   // iPhone : le son ne démarre qu'après un geste de l'utilisateur
    const o = AC.createOscillator(), g = AC.createGain(), t = AC.currentTime + t0;
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.012); g.gain.exponentialRampToValueAtTime(0.001, t + d);
    o.connect(g).connect(AC.destination); o.start(t); o.stop(t + d + 0.05);
  } catch (e) { /* pas d'audio */ }
}
function son(k) {
  if (!PROG || !PROG.son) return;
  if (k === "bon") { note(784, 0, 0.14); note(1175, 0.08, 0.28); }
  else if (k === "faux") { note(233, 0, 0.22, "triangle", 0.2); note(196, 0.12, 0.3, "triangle", 0.2); }
  else if (k === "victoire") [523, 659, 784, 1047, 1319].forEach((f, i) => note(f, i * 0.1, 0.35));
  else if (k === "defaite") [392, 330, 262].forEach((f, i) => note(f, i * 0.17, 0.4, "triangle"));
  else if (k === "clic") note(660, 0, 0.05, "sine", 0.05);
  else if (k === "badge") [880, 1109, 1319, 1760].forEach((f, i) => note(f, i * 0.07, 0.3, "sine", 0.1));
}

// ------------------------------------------------------------------ voix anglaise
let VOIX = null;
function choisirVoix() {
  const vs = speechSynthesis.getVoices().filter(v => v.lang.toLowerCase().startsWith("en"));
  VOIX = vs.find(v => /natural/i.test(v.name)) || vs.find(v => /aria|jenny|guy|libby|sonia|ryan/i.test(v.name))
      || vs.find(v => /en-(us|gb)/i.test(v.lang)) || vs[0] || null;
}
if ("speechSynthesis" in window) { choisirVoix(); speechSynthesis.onvoiceschanged = choisirVoix; }
// Voix naturelle (Microsoft, via Python, mise en cache) → voix du navigateur → voix Windows hors ligne.
// parler() renvoie une promesse résolue quand la phrase est finie (ou coupée) : utile pour enchaîner les répliques.
let AUDIO = null, jetonVoix = 0, finEnCours = null;
function couperVoix() {
  jetonVoix++;
  if (AUDIO) { AUDIO.pause(); AUDIO = null; }
  window.speechSynthesis?.cancel();
  if (finEnCours) { const f = finEnCours; finEnCours = null; f(); }
}
function parler(txt, lent = false, voix = null) {
  return new Promise(async fin => {
    if (!txt) return fin();
    couperVoix();
    const jeton = jetonVoix;
    finEnCours = fin;
    const terminer = () => { if (finEnCours === fin) finEnCours = null; fin(); };
    if (API && PROG?.voixNaturelle !== false) {
      try {
        const url = await API.audio(txt, lent, voix);
        if (jeton !== jetonVoix) return;   // une autre phrase a été demandée entre-temps
        if (url) {
          AUDIO = new Audio(url);
          AUDIO.onended = AUDIO.onerror = terminer;
          AUDIO.play().catch(terminer);
          return;
        }
      } catch (e) { /* repli ci-dessous */ }
    }
    if (jeton !== jetonVoix) return;
    if (VOIX) {
      const u = new SpeechSynthesisUtterance(txt);
      u.voice = VOIX; u.lang = VOIX.lang; u.rate = lent ? 0.62 : 0.92;
      u.onend = u.onerror = terminer;
      speechSynthesis.speak(u);
    } else if (API) { API.dire(txt, lent); setTimeout(terminer, 500 + txt.length * (lent ? 110 : 70)); }
    else setTimeout(terminer, 300);
  });
}

// ------------------------------------------------------------------ mémoire (répétition espacée)
// Probabilité de rappel p = 2^(-Δ/h) : h = « demi-vie » de l'élément en jours (Settles & Meeder, 2016).
function proba(id) {
  const s = PROG.items[id];
  if (!s || !s.n) return 0;
  return Math.pow(2, -((Date.now() - s.t) / JOUR) / s.h);
}
function majMemoire(id, juste, production) {
  const s = PROG.items[id] || (PROG.items[id] = { s: 0, h: 0, t: 0, n: 0, ok: 0, ko: 0 });
  const espace = !s.n || Date.now() - s.t > 3600000;   // la mémoire ne se renforce vraiment qu'avec de l'espacement
  if (juste) {
    if (!s.h) s.h = production ? 1.5 : 1;
    else if (espace) s.h = Math.min(180, s.h * (production ? 3 : 2.2));
    if (espace) s.s = Math.min(5, s.s + 1);
    s.ok++; s.c = (s.c || 0) + 1;   // c = bonnes réponses d'affilée
  } else {
    s.h = Math.max(0.15, (s.h || 0.4) * 0.35);
    s.s = Math.max(0, s.s - 1);
    s.ko++; s.c = 0;
  }
  s.n++; s.t = Date.now();
}
const aReviser = () => Object.keys(PROG.items).filter(id => PROG.items[id].n && proba(id) < 0.8).sort((a, b) => proba(a) - proba(b));
const motsVus = () => VOCAB.filter(v => PROG.items[v.id]?.n).length;
const motsMaitrises = () => VOCAB.filter(v => (PROG.items[v.id]?.s || 0) >= 3).length;
const verbesVus = () => VERBES.filter(v => PROG.items[v.id]?.n).length;
const verbesMaitrises = () => VERBES.filter(v => (PROG.items[v.id]?.s || 0) >= 3).length;
const formes = s => s.split("/");                       // "was/were" → ["was", "were"]
const troisFormes = v => `${v.base} – ${v.pret} – ${v.part}`;
const direVerbe = (v, lent) => parler(`${v.base}. ${formes(v.pret).join(", ")}. ${formes(v.part).join(", ")}.`, lent);
// Leçons en 2 parties de 5 phrases : plus courtes, et une partie réussie reste acquise.
const PARTIES = [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9]];
const etoilesPartie = (i, k) => PROG.lecons[i]?.parties?.[k] || 0;
const etoiles = i => PROG.lecons[i]?.etoiles || 0;
const debloquee = i => i === 0 || etoiles(i - 1) > 0;
const nbLeconsFaites = () => LECONS.filter(l => etoiles(l.i) > 0).length;
const mondeFini = mi => LECONS.filter(l => l.mi === mi).every(l => etoiles(l.i) > 0);
function prochaineLecon() { const l = LECONS.find(l => debloquee(l.i) && !etoiles(l.i)); return l ? l.i : null; }
function prochainePartie() {
  const i = prochaineLecon();
  if (i === null) return null;
  return { i, k: etoilesPartie(i, 0) ? 1 : 0 };
}
function validerPartie(i, k, nbEtoiles) {
  const info = PROG.lecons[i] || (PROG.lecons[i] = { etoiles: 0, tentatives: 0 });
  info.parties = info.parties || {};
  info.parties[k] = Math.max(info.parties[k] || 0, nbEtoiles);
  if (info.parties[0] && info.parties[1]) info.etoiles = Math.max(info.etoiles, Math.min(info.parties[0], info.parties[1]));
}
// les packs sont proposés dans l'ordre des niveaux (A1 d'abord, C2 en dernier)
function prochainPack() {
  const p = [...PACKS].sort((a, b) => NIVEAUX.indexOf(a.niveau) - NIVEAUX.indexOf(b.niveau) || a.pi - b.pi)
    .find(p => p.ids.some(id => !PROG.items[id]?.n));
  return p ? p.pi : null;
}

// ------------------------------------------------------------------ paliers CECRL (A1 → C2)
const NIVEAUX = ["A1", "A2", "B1", "B2", "C1", "C2"];
const INFOS_NIVEAUX = {
  A1: { nom: "Découverte", ic: "🌱", couleur: "#22d3a6", desc: "Tu comprends et utilises des expressions familières et des phrases très simples.",
    peux: ["Te présenter et présenter quelqu'un", "Poser des questions simples (où tu habites, ce que tu aimes…)", "Comprendre des mots familiers quand on parle lentement"] },
  A2: { nom: "Survie", ic: "🧭", couleur: "#4cc9ff", desc: "Tu te débrouilles dans les situations simples et habituelles du quotidien.",
    peux: ["Raconter ce que tu as fait hier ou le week-end dernier", "Faire des achats, commander au restaurant, demander ton chemin", "Comprendre l'essentiel de messages courts et clairs"] },
  B1: { nom: "Indépendant", ic: "🎒", couleur: "#7c5cff", desc: "Tu te débrouilles en voyage, tu racontes, tu donnes ton avis et tu le justifies.",
    peux: ["Suivre une conversation sur un sujet familier", "Raconter une histoire, un film, un projet, et donner ton avis", "Comprendre l'essentiel d'une série avec les sous-titres anglais"] },
  B2: { nom: "Avancé", ic: "🚀", couleur: "#ffc83d", desc: "Tu échanges avec aisance et spontanéité avec des natifs, et tu comprends des textes complexes.",
    peux: ["Discuter naturellement avec un anglophone, sans effort pour lui", "Comprendre la plupart des films et séries", "Défendre un point de vue en donnant des arguments"] },
  C1: { nom: "Autonome", ic: "🏅", couleur: "#ff8a3d", desc: "Tu t'exprimes couramment et avec nuance, y compris dans un cadre professionnel.",
    peux: ["Comprendre des textes longs et exigeants, et l'implicite", "T'exprimer avec fluidité, sans chercher tes mots", "Utiliser l'anglais au travail ou dans des études supérieures"] },
  C2: { nom: "Maîtrise", ic: "👑", couleur: "#ff5c7a", desc: "Tu comprends pratiquement tout sans effort : c'est le niveau dit « bilingue ».",
    peux: ["Comprendre sans effort tout ce que tu lis ou entends", "Saisir les nuances fines, l'humour et les sous-entendus", "Adapter ton registre (formel, familier) à chaque situation"] },
};
// part du vocabulaire cumulé à avoir acquis pour valider chaque palier
const RATIO_MOTS = { A1: 0.6, A2: 0.7, B1: 0.75, B2: 0.8, C1: 0.85, C2: 0.9 };
const motAcquis = id => (PROG.items[id]?.s || 0) >= 2;   // réussi au moins 2 fois, à des moments espacés
const arrondi10 = n => Math.max(10, Math.round(n / 10) * 10);
function seuilMots(n) {
  const cumul = VOCAB.filter(v => NIVEAUX.indexOf(PACKS[v.pi].niveau) <= NIVEAUX.indexOf(n)).length;
  return arrondi10(cumul * RATIO_MOTS[n]);
}
function criteresPalier(n) {
  const crit = [{ ic: "📚", libelle: "Mots acquis", actuel: VOCAB.filter(v => motAcquis(v.id)).length, cible: seuilMots(n), unite: "mots" }];
  const lecons = LECONS.filter(l => l.niveau === n);
  if (lecons.length) crit.push({ ic: "📘", libelle: `Leçons de grammaire ${n}`, actuel: lecons.filter(l => etoiles(l.i)).length, cible: lecons.length, unite: "leçons" });
  const verbesCible = { A2: 30, B1: 70, B2: 100 }[n];
  if (verbesCible) crit.push({ ic: "🔁", libelle: "Verbes irréguliers acquis", actuel: VERBES.filter(v => motAcquis(v.id)).length, cible: Math.min(verbesCible, VERBES.length), unite: "verbes" });
  const histCible = { B1: 8, B2: 14, C1: 16, C2: 18 }[n];
  if (histCible) crit.push({ ic: "📖", libelle: "Histoires lues", actuel: Object.keys(PROG.histoires).length, cible: Math.min(histCible, HISTOIRES.length), unite: "histoires" });
  const sceneCible = { B2: 5, C1: 10 }[n];
  if (sceneCible) crit.push({ ic: "🎬", libelle: "Scènes du Ciné-club", actuel: Object.keys(PROG.scenes).length, cible: Math.min(sceneCible, CINE.length), unite: "scènes" });
  return crit;
}
const paliersAtteints = () => NIVEAUX.filter(n => PROG.paliers?.[n]);
const niveauActuel = () => paliersAtteints().pop() || null;           // null = avant A1
const prochainNiveau = () => NIVEAUX.find(n => !PROG.paliers?.[n]) || null;
function avancement(n) {   // de 0 à 1 : moyenne des critères
  const c = criteresPalier(n);
  return c.reduce((t, x) => t + Math.min(1, x.actuel / x.cible), 0) / c.length;
}
function verifierPaliers() {   // valide les paliers dans l'ordre ; renvoie ceux qui viennent d'être atteints
  PROG.paliers = PROG.paliers || {};
  const nouveaux = [];
  for (const n of NIVEAUX) {
    if (PROG.paliers[n]) continue;
    if (criteresPalier(n).every(c => c.actuel >= c.cible)) { PROG.paliers[n] = aujourdhui(); nouveaux.push(n); }
    else break;
  }
  return nouveaux;
}
function noterSuivi() {   // une photo par jour, pour le graphique et l'estimation du temps restant
  PROG.suivi = PROG.suivi || {};
  PROG.suivi[aujourdhui()] = { acquis: VOCAB.filter(v => motAcquis(v.id)).length, connus: Object.values(PROG.items).filter(s => s.s >= 3).length, xp: PROG.xp };
}
function rythmeMotsParJour() {
  const jours = Object.keys(PROG.suivi || {}).sort();
  if (jours.length < 2) return null;
  const debut = jours.find(j => joursEntre(j, aujourdhui()) <= 14) || jours[0];
  const nb = joursEntre(debut, jours[jours.length - 1]);
  return nb > 0 ? (PROG.suivi[jours[jours.length - 1]].acquis - PROG.suivi[debut].acquis) / nb : null;
}
function celebrerPalier(n) {
  const I = INFOS_NIVEAUX[n], suivant = NIVEAUX[NIVEAUX.indexOf(n) + 1];
  son("victoire"); setTimeout(() => son("badge"), 700);
  confettis(); setTimeout(confettis, 1200);
  const voile = document.createElement("div");
  voile.className = "voile-palier";
  voile.innerHTML = `<div class="carte-palier" style="--couleur:${I.couleur}">
      <div class="rayons"></div>
      <div class="medaille">${I.ic}<span>${n}</span></div>
      <small>Nouveau palier atteint !</small>
      <h1>Niveau ${n} · ${I.nom}</h1>
      <p>${I.desc}</p>
      <div class="peux"><b>Ce que tu sais faire maintenant :</b>${I.peux.map(x => `<div>✅ ${esc(x)}</div>`).join("")}</div>
      ${suivant ? `<p class="sous">Prochain objectif : <b>${suivant} · ${INFOS_NIVEAUX[suivant].nom}</b> ${INFOS_NIVEAUX[suivant].ic}</p>` : `<p class="sous">Tu as atteint le plus haut niveau de l'appli. Bravo, c'est immense ! 🎉</p>`}
      <div class="actions"><button class="btn gris" id="fermer-palier">Continuer</button><button class="btn vert" id="voir-niveau">Voir mon niveau</button></div>
    </div>`;
  document.body.appendChild(voile);
  $("#fermer-palier").onclick = () => voile.remove();
  $("#voir-niveau").onclick = () => { voile.remove(); niveau(); };
}
function celebrerNouveauxPaliers() {
  const nouveaux = verifierPaliers();
  nouveaux.forEach((n, k) => setTimeout(() => celebrerPalier(n), 1200 + k * 400));
  return nouveaux;
}
function prochainPackVerbes() { const p = VPACKS.find(p => p.ids.some(id => !PROG.items[id]?.n)); return p ? p.pi : null; }
// prochaine histoire non lue, sans dépasser le niveau visé (palier suivant)
const niveauVise = () => prochainNiveau() || "C2";
const accessible = niv => NIVEAUX.indexOf((niv || "A1").replace("+", "")) <= NIVEAUX.indexOf(niveauVise());
const prochaineHistoire = () => HISTOIRES.findIndex((h, s) => !PROG.histoires[s] && accessible(h.niveau));
// Points faibles : déjà ratés au moins 2 fois, et pas encore réussis 3 fois de suite depuis.
const pointsFaibles = () => Object.keys(PROG.items)
  .filter(id => PROG.items[id].ko >= 2 && (PROG.items[id].c || 0) < 3)
  .sort((a, b) => (PROG.items[b].ko - PROG.items[b].ok * 0.3) - (PROG.items[a].ko - PROG.items[a].ok * 0.3));
function texteAnglais(id) {   // la phrase anglaise associée à un élément (pour la voix et la dictée)
  if (id[0] === "p") { const [, i, j] = id.split("-").map(Number), p = LECONS[i].phrases[j]; return p[0] === "fr-en" ? p[2] : p[1]; }
  if (id[0] === "v") return VBYID[id].en;
  if (id[0] === "i") { const v = IBYID[id]; return `${v.base}. ${formes(v.pret).join(", ")}. ${formes(v.part).join(", ")}.`; }
  if (id[0] === "c") return ligneCine(id).en;
  return "";
}
const voixDe = id => id[0] === "c" ? ligneCine(id).voix : null;
// Ciné-club : une réplique « c-s-l » = scène s, ligne l
function ligneCine(id) {
  const [, s, l] = id.split("-").map(Number), scene = CINE[s], [perso, en, fr, trou, piegesTrou, piegesFr] = scene.lignes[l];
  return { s, l, scene, perso, en, fr, trou, piegesTrou, piegesFr, voix: scene.persos[perso] };
}
const idsScene = s => CINE[s].lignes.map((_, l) => `c-${s}-${l}`);
const prochaineScene = () => CINE.findIndex((sc, s) => !PROG.scenes?.[s] && accessible(sc.niveau));

// ------------------------------------------------------------------ XP, série, gels, rangs, badges
const RANGS = [[0, "Débutant", "🥚"], [200, "Apprenti", "🐣"], [600, "Explorateur", "🧭"], [1500, "Aventurier", "⚔️"], [3000, "Héros", "🛡️"], [6000, "Légende", "🐉"], [12000, "Mythique", "🌌"]];
const rang = () => RANGS.filter(r => PROG.xp >= r[0]).pop();
const joursEntre = (a, b) => Math.round((new Date(b + "T12:00") - new Date(a + "T12:00")) / JOUR);
function joursManques() { return PROG.dernierJour ? Math.max(0, joursEntre(PROG.dernierJour, aujourdhui()) - 1) : 0; }
// La série tient tant que les jours manqués peuvent être couverts par des gels.
function serieActuelle() { return !PROG.dernierJour ? 0 : joursManques() <= (PROG.gels || 0) ? PROG.serie : 0; }
function gagnerXP(n) {
  const j = aujourdhui();
  if (PROG.dernierJour !== j) {
    const manques = joursManques();
    if (PROG.dernierJour && manques > 0 && manques <= (PROG.gels || 0)) {
      PROG.gels -= manques;
      PROG.serie += 1;
      setTimeout(() => toast("❄️", `Gel de série utilisé (${manques})`, `Ta série de ${PROG.serie} jours est sauvée !`), 600);
    } else PROG.serie = manques === 0 && PROG.dernierJour ? PROG.serie + 1 : 1;
    PROG.dernierJour = j;
    PROG.meilleureSerie = Math.max(PROG.meilleureSerie, PROG.serie);
  }
  const avant = PROG.jours[j] || 0;
  PROG.xp += n;
  PROG.jours[j] = avant + n;
  if (avant < PROG.objectif && PROG.jours[j] >= PROG.objectif) {   // objectif du jour atteint
    PROG.joursObjectif = (PROG.joursObjectif || 0) + 1;
    setTimeout(() => { son("badge"); toast("🎯", "Objectif du jour atteint !", "Bravo, ta série continue."); }, 500);
    if (PROG.joursObjectif % 7 === 0 && (PROG.gels || 0) < 2) {
      PROG.gels = (PROG.gels || 0) + 1;
      setTimeout(() => toast("❄️", "Nouveau gel de série !", "Il protégera ta série si tu manques un jour."), 1800);
    }
  }
}
const BADGES = [
  { id: "premier", ic: "🎯", nom: "Premier pas", desc: "Termine ta première leçon", ok: () => nbLeconsFaites() >= 1 },
  { id: "parfait", ic: "💎", nom: "Sans faute", desc: "Une leçon à 3 étoiles", ok: () => Object.values(PROG.lecons).some(l => l.etoiles === 3) },
  { id: "objectif", ic: "✅", nom: "Objectif atteint", desc: "Atteins ton objectif du jour", ok: () => Object.values(PROG.jours).some(x => x >= PROG.objectif) },
  { id: "serie3", ic: "🔥", nom: "Ça chauffe", desc: "3 jours d'affilée", ok: () => PROG.meilleureSerie >= 3 },
  { id: "serie7", ic: "🌋", nom: "Une semaine", desc: "7 jours d'affilée", ok: () => PROG.meilleureSerie >= 7 },
  { id: "serie30", ic: "🏆", nom: "Inarrêtable", desc: "30 jours d'affilée", ok: () => PROG.meilleureSerie >= 30 },
  { id: "combo10", ic: "⚡", nom: "Combo x10", desc: "10 bonnes réponses d'affilée", ok: () => PROG.stats.meilleurCombo >= 10 },
  { id: "mots50", ic: "📚", nom: "Collectionneur", desc: "Découvre 50 mots", ok: () => motsVus() >= 50 },
  { id: "mots100", ic: "🧠", nom: "Mémoire d'acier", desc: "Maîtrise 100 mots", ok: () => motsMaitrises() >= 100 },
  { id: "monde1", ic: "🌱", nom: "Les bases", desc: "Termine le Monde 1", ok: () => mondeFini(0) },
  { id: "monde2", ic: "🌿", nom: "Débrouillard", desc: "Termine le Monde 2", ok: () => mondeFini(1) },
  { id: "monde3", ic: "🌳", nom: "Conteur", desc: "Termine le Monde 3", ok: () => mondeFini(2) },
  { id: "verbes20", ic: "🔁", nom: "Machine à verbes", desc: "Maîtrise 20 verbes irréguliers", ok: () => verbesMaitrises() >= 20 },
  { id: "verbes100", ic: "🎓", nom: "Par cœur !", desc: "Maîtrise les 100 verbes irréguliers", ok: () => verbesMaitrises() >= 100 },
  { id: "chrono15", ic: "⏱️", nom: "Rapide comme l'éclair", desc: "15 points au défi 60 secondes", ok: () => (PROG.recordChrono || 0) >= 15 },
  { id: "xp1000", ic: "👑", nom: "1000 XP", desc: "Gagne 1000 XP", ok: () => PROG.xp >= 1000 },
  { id: "monde4", ic: "🚀", nom: "Plus loin", desc: "Termine le Monde 4", ok: () => LECONS.some(l => l.mi === 3) && mondeFini(3) },
  { id: "lecteur", ic: "📖", nom: "Lecteur", desc: "Lis 5 histoires", ok: () => Object.keys(PROG.histoires).length >= 5 },
  { id: "faibles", ic: "🎯", nom: "Plus de points faibles", desc: "Corrige 10 points faibles", ok: () => (PROG.faiblesCorriges || 0) >= 10 },
  { id: "xp5000", ic: "💫", nom: "5000 XP", desc: "Gagne 5000 XP", ok: () => PROG.xp >= 5000 },
  { id: "cine5", ic: "🎬", nom: "Cinéphile", desc: "Regarde 5 scènes du Ciné-club", ok: () => Object.keys(PROG.scenes || {}).length >= 5 },
  { id: "connus100", ic: "🌟", nom: "100 bien connus", desc: "100 mots, verbes ou phrases bien connus", ok: () => Object.values(PROG.items).filter(s => s.s >= 3).length >= 100 },
];
NIVEAUX.forEach(n => BADGES.push({ id: "palier" + n, ic: INFOS_NIVEAUX[n].ic, nom: `Niveau ${n}`, desc: `Atteins le palier ${n} · ${INFOS_NIVEAUX[n].nom}`, ok: () => !!PROG.paliers?.[n] }));
function verifierBadges() {
  const nouveaux = BADGES.filter(b => !PROG.badges.includes(b.id) && b.ok());
  nouveaux.forEach(b => PROG.badges.push(b.id));
  return nouveaux;
}
function toast(ic, titre, sous) {
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = `<span class="ic">${ic}</span><div><b>${esc(titre)}</b><small>${esc(sous)}</small></div>`;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

// ------------------------------------------------------------------ science (affichée dans l'appli)
const SCIENCE = [
  { ic: "🧠", titre: "Se tester plutôt que relire", chiffre: "61 % retenu contre 40 % après une semaine",
    p: "Chercher la réponse dans sa mémoire la renforce bien plus que relire (effet de test). Une méta-analyse de 159 études confirme l'effet, à condition d'avoir une correction.",
    etude: "Roediger & Karpicke (2006) ; Karpicke & Roediger (2008, Science) ; Rowland (2014)",
    appli: "Tout est un mini-test, avec la correction tout de suite après." },
  { ic: "📅", titre: "Réviser au bon moment", chiffre: "Duolingo : −45 % d'erreurs de prédiction",
    p: "Espacer les révisions fait mieux retenir que tout réviser d'un coup. L'idéal : revoir un mot juste avant de l'oublier, puis de plus en plus rarement.",
    etude: "Kim & Webb (2022, méta-analyse de 37 études) ; Settles & Meeder (2016)",
    appli: "Chaque phrase et chaque mot a une « demi-vie » : l'appli te les redonne quand ta mémoire commence à s'effacer." },
  { ic: "✍️", titre: "Produire, pas seulement reconnaître", chiffre: "Effet plus fort en production",
    p: "Retrouver un mot soi-même (l'écrire, construire la phrase) ancre mieux qu'un simple choix parmi plusieurs réponses.",
    etude: "Rowland (2014) ; Barcroft (2007)",
    appli: "Tu commences par des QCM, puis tu construis la phrase avec des étiquettes, puis tu l'écris toi-même." },
  { ic: "🔀", titre: "Mélanger les sujets", chiffre: "Effet moyen g = 0,42",
    p: "Alterner différents points (passé, présent, vocabulaire…) aide à les distinguer, au lieu de répéter 10 fois la même chose.",
    etude: "Brunmair & Richter (2019, Psychological Bulletin, 59 études)",
    appli: "Les révisions du jour mélangent tous les niveaux et le vocabulaire." },
  { ic: "💡", titre: "Expliquer la règle", chiffre: "Explicite > implicite",
    p: "Chez les adultes, une explication claire de la règle accélère l'apprentissage par rapport à la seule exposition.",
    etude: "Norris & Ortega (2000) ; Goo et al. (2015) ; Spada & Tomita (2010)",
    appli: "Chaque leçon commence par une mini-leçon avec des exemples à écouter, et chaque erreur est expliquée." },
  { ic: "🩹", titre: "Corriger tout de suite", chiffre: "Effets significatifs et durables",
    p: "Les corrections, surtout quand elles expliquent l'erreur, améliorent durablement la maîtrise de la langue.",
    etude: "Li (2010, méta-analyse de 33 études) ; Lyster & Saito (2010)",
    appli: "Après chaque erreur : la bonne réponse, une astuce, et la phrase revient un peu plus tard." },
  { ic: "📊", titre: "Les mots les plus fréquents d'abord", chiffre: "2 000 mots ≈ 87–90 % d'un texte",
    p: "Une petite partie du vocabulaire couvre l'essentiel de ce qu'on lit et entend. Pour vraiment comprendre, il faut connaître 95 à 98 % des mots.",
    etude: "Nation (2006) ; Hirsh & Nation (1992) ; Hu & Nation (2000)",
    appli: "Le module Vocabulaire part des mots les plus fréquents, puis passe au gaming et aux séries." },
  { ic: "🎬", titre: "Écouter avec le texte", chiffre: "Effet important, g ≈ 0,87 sur le vocabulaire",
    p: "Regarder des vidéos avec les sous-titres dans la langue étudiée améliore la compréhension orale et le vocabulaire.",
    etude: "Montero Perez, Van Den Noortgate & Desmet (2013, méta-analyse)",
    appli: "Le Ciné-club : des scènes jouées par plusieurs voix, avec sous-titres anglais (et français à la demande), à traduire et à compléter. Conseil : regarde aussi tes séries en VO avec les sous-titres ANGLAIS." },
  { ic: "🧩", titre: "Apprendre des blocs de mots", chiffre: "Plus fluide, jugé plus compétent",
    p: "Les expressions toutes faites (« wait for me », « well played ») se retiennent comme des blocs et rendent plus fluide.",
    etude: "Boers et al. (2006) ; Boers & Lindstromberg (2012)",
    appli: "On apprend des phrases entières et utiles plutôt que des mots isolés." },
  { ic: "🎮", titre: "Le jeu motive… et fait apprendre", chiffre: "g = 0,49 sur l'apprentissage",
    p: "Points, séries et défis augmentent la motivation et les résultats, surtout quand ils accompagnent un vrai contenu.",
    etude: "Sailer & Homner (2020, Educational Psychology Review)",
    appli: "XP, série de jours, objectif quotidien, étoiles, badges, combos." },
  { ic: "📖", titre: "Beaucoup lire et écouter", chiffre: "Effet positif confirmé par 2 méta-analyses",
    p: "On progresse en recevant beaucoup d'anglais qu'on comprend presque entièrement (« input compréhensible »). Lire des histoires à son niveau développe le vocabulaire et la compréhension.",
    etude: "Krashen (1982) ; Nakanishi (2015) ; Jeon & Day (2016)",
    appli: "Des histoires à ton niveau, lues par une voix naturelle, avec la traduction à la demande et des questions." },
  { ic: "🔀", titre: "Une session qui mélange tout", chiffre: "Mélanger > bloquer",
    p: "Alterner grammaire, vocabulaire, verbes, écoute et lecture dans une même session oblige le cerveau à choisir la bonne stratégie, ce qui renforce la mémoire.",
    etude: "Brunmair & Richter (2019) ; Rohrer & Taylor (2007)",
    appli: "La session du jour mélange révisions, leçon, mots, verbes, dictée, histoire et points faibles." },
  { ic: "⏱️", titre: "Un peu chaque jour", chiffre: "10 minutes/jour > 1 h/semaine",
    p: "La pratique distribuée sur plusieurs jours, avec du sommeil entre les sessions, consolide la mémoire.",
    etude: "Cepeda et al. (2006, méta-analyse) ; Kim & Webb (2022)",
    appli: "Objectif quotidien réglable et série de jours : la régularité compte plus que la durée." },
];

// ------------------------------------------------------------------ chargement
let demarre = false;
async function init(data) {
  if (demarre) return;
  demarre = true;
  MONDES = data.lecons;
  MONDES.forEach((m, mi) => m.niveaux.forEach(n => LECONS.push({ ...n, monde: m.monde, niveau: m.niveau || "A1", mi, i: LECONS.length })));
  PACKS = data.vocab.map((p, pi) => ({ ...p, pi, ids: [] }));
  PACKS.forEach(p => p.mots.forEach(([en, fr]) => {
    const id = "v-" + VOCAB.length;
    VOCAB.push({ id, en, fr, pi: p.pi });
    p.ids.push(id);
  }));
  VBYID = Object.fromEntries(VOCAB.map(v => [v.id, v]));
  VPACKS = data.verbes.map((p, pi) => ({ ...p, pi, ids: [] }));
  VPACKS.forEach(p => p.verbes.forEach(([base, pret, part, fr]) => {
    const id = "i-" + VERBES.length;
    VERBES.push({ id, base, pret, part, fr, pi: p.pi });
    p.ids.push(id);
  }));
  IBYID = Object.fromEntries(VERBES.map(v => [v.id, v]));
  HISTOIRES = data.histoires || [];
  CINE = data.cine || [];
  const ancien = data.prog && !data.prog.version || data.prog?.version < 3;
  PROG = Object.assign(progDefaut(), data.prog || {});
  PROG.stats = Object.assign(progDefaut().stats, PROG.stats);
  PROG.scenes = PROG.scenes || {};
  if (ancien) {   // migration : les leçons déjà réussies comptent pour leurs 2 parties
    Object.values(PROG.lecons).forEach(l => { if (l.etoiles && !l.parties) l.parties = { 0: l.etoiles, 1: l.etoiles }; });
    PROG.version = 3;
    sauver();
  }
  PROG.paliers = PROG.paliers || {};
  COMPTE = cloudConfigure() ? await lireCompte() : null;
  accueil();
  if (celebrerNouveauxPaliers().length) { noterSuivi(); sauver(); }
  if (COMPTE) synchroniser(true);   // récupère ce qui a été fait sur l'autre appareil
}
window.addEventListener("pywebviewready", async () => { API = window.pywebview.api; init(await API.charger()); });
setTimeout(async () => {   // aperçu dans un navigateur (sans pywebview)
  if (demarre || window.pywebview) return;
  // version en ligne : les fichiers JSON sont à côté de index.html ; en développement, dans le dossier parent
  const base = location.pathname.includes("/web/") ? "../" : "./";
  const [lecons, vocab, verbes, histoires, cine] = await Promise.all(["lecons", "vocab", "verbes", "histoires", "cine"].map(f => fetch(`${base}${f}.json`).then(r => r.json())));
  let prog = null;
  try { prog = JSON.parse(localStorage.getItem("englishquest")); } catch (e) { /* rien */ }
  init({ lecons, vocab, verbes, histoires, cine, prog });
}, 900);

// ------------------------------------------------------------------ gabarit
function barreHaut(retour) {
  const r = rang();
  return `<header class="topbar">
    ${retour ? `<button class="retour" data-go="accueil">← Accueil</button>` : ""}
    <div class="logo" data-go="accueil"><span class="badge-logo">EQ</span>English Quest</div>
    <div class="espace"></div>
    <div class="pastille feu" title="Série de jours">🔥 ${serieActuelle()}</div>
    <div class="pastille gel" title="Gels de série : ils protègent ta série si tu manques un jour">❄️ ${PROG.gels || 0}</div>
    <div class="pastille xp" title="Points d'expérience">⚡ ${PROG.xp} XP</div>
    <button class="pastille rang" data-go="niveau" title="Ton niveau d'anglais (rang : ${r[1]})">🎓 ${niveauActuel() || "Pré-A1"}</button>
    <span class="indic-sync" id="indic-sync"></span>
    <button class="icon-btn" data-son title="Son">${PROG.son ? "🔊" : "🔇"}</button>
  </header>`;
}
function afficher(html, retour = true) {
  gestionTouches = null;
  clearInterval(minuteurChrono);
  couperVoix();
  $("#app").innerHTML = barreHaut(retour) + `<div class="contenu"><div class="largeur screen">${html}</div></div>`;
  brancherCommun();
  majIndicateurSync();
}
function brancherCommun() {
  $$("[data-go]").forEach(b => b.onclick = () => ({ accueil, carte, vocabulaire: () => vocabulaire(), verbes, histoires, cine, mesMots: () => mesMots(), niveau: () => niveau(), classement: () => classement(), progres, science }[b.dataset.go])());
  const s = $("[data-son]");
  if (s) s.onclick = () => { PROG.son = !PROG.son; s.textContent = PROG.son ? "🔊" : "🔇"; sauver(); son("clic"); };
}

// ------------------------------------------------------------------ écran d'accueil
// La session du jour mélange tout (entrelacement) : révisions, une partie de leçon, nouveaux mots,
// verbes irréguliers, dictée, histoire et points faibles. Les découvertes précèdent toujours leurs questions.
function composerSessionDuJour() {
  const partie = prochainePartie(), pack = prochainPack(), packV = prochainPackVerbes(), h = prochaineHistoire();
  const idsPartie = partie ? PARTIES[partie.k].map(j => `p-${partie.i}-${j}`) : [];   // jamais en double dans la session
  const faibles = pointsFaibles().filter(id => !idsPartie.includes(id)).slice(0, 2);
  const enRetard = aReviser().filter(id => !faibles.includes(id) && !idsPartie.includes(id));
  // beaucoup de révisions en retard → plus de révisions et moins de nouveautés, pour ne pas laisser la pile grossir
  const nbRev = enRetard.length > 40 ? 12 : enRetard.length > 15 ? 10 : 8, nbMots = enRetard.length > 40 ? 1 : enRetard.length > 20 ? 2 : 3;
  const rev = shuffle(enRetard.slice(0, nbRev));
  const pris = new Set([...rev, ...faibles, ...idsPartie]);
  const mots = pack !== null ? PACKS[pack].ids.filter(id => !PROG.items[id]?.n).slice(0, nbMots) : [];
  const verbesN = packV !== null ? VPACKS[packV].ids.filter(id => !PROG.items[id]?.n).slice(0, enRetard.length > 40 ? 1 : 2) : [];
  const dictees = shuffle(Object.keys(PROG.items).filter(id => id[0] === "p" && PROG.items[id].ok >= 1 && !pris.has(id))).slice(0, 2);
  const file = [], resume = [];
  let infoPartie = null;
  if (rev.length) resume.push(["🔄", `${rev.length} révision${rev.length > 1 ? "s" : ""}`, enRetard.length > rev.length ? `${enRetard.length - rev.length} autres en attente` : "juste avant l'oubli"]);
  file.push(...rev.slice(0, 3).map(id => ({ id })));
  if (partie) {
    const { i, k } = partie, L = LECONS[i], ids = PARTIES[k].map(j => `p-${i}-${j}`);
    const fren = ids.filter(id => L.phrases[+id.split("-")[2]][0] === "fr-en");
    file.push({ regle: true, i, k }, ...shuffle(ids).map(id => ({ id })));
    if (fren.length) file.push({ id: pick(fren), mode: "tiles" });
    infoPartie = { i, k, ids };
    resume.push(["📘", `Leçon ${i + 1} · partie ${k + 1}/2`, L.titre]);
  }
  file.push(...rev.slice(3, 6).map(id => ({ id })));
  if (mots.length) { file.push(...sequenceNouveaux(mots, "qcm", null)); resume.push(["✨", mots.length > 1 ? `${mots.length} nouveaux mots` : "1 nouveau mot", PACKS[pack].pack]); }
  if (faibles[0]) file.push({ id: faibles[0], fiche: true }, { id: faibles[0] });
  if (verbesN.length) { file.push(...sequenceNouveaux(verbesN, "qcm-pret", null)); resume.push(["🔁", verbesN.length > 1 ? `${verbesN.length} verbes irréguliers` : "1 verbe irrégulier", VPACKS[packV].pack]); }
  if (dictees.length) { file.push(...dictees.map(id => ({ id, mode: "dictee" }))); resume.push(["🎧", `${dictees.length} dictée${dictees.length > 1 ? "s" : ""}`, "écouter et écrire"]); }
  // un jour sur deux : une histoire ou une scène du Ciné-club (selon ce qu'il reste à découvrir)
  const sc = prochaineScene(), jourCine = new Date().getDate() % 2 === 0;
  if (sc >= 0 && (jourCine || h < 0)) {
    const ids = shuffle(idsScene(sc));
    file.push({ scene: sc }, ...ids.slice(0, 4).map(id => ({ id, mode: "trad" })), ...ids.slice(4).map(id => ({ id, mode: "trou-qcm" })));
    resume.push(["🎬", "Une scène de film", `${CINE[sc].genre} · ${CINE[sc].titre}`]);
  } else if (h >= 0) { file.push({ histoire: h }, ...HISTOIRES[h].questions.map((_, q) => ({ question: [h, q] }))); resume.push(["📖", "Une histoire", HISTOIRES[h].titre]); }
  file.push(...rev.slice(6).map(id => ({ id })));
  if (faibles[1]) file.push({ id: faibles[1], fiche: true }, { id: faibles[1] });
  if (faibles.length) resume.push(["🎯", `${faibles.length} point${faibles.length > 1 ? "s" : ""} faible${faibles.length > 1 ? "s" : ""}`, "avec explication"]);
  return { file, resume, partie: infoPartie };
}
const estExercice = e => !e.intro && !e.regle && !e.fiche && !("histoire" in e) && !("scene" in e);

function accueil() {
  const plan = composerSessionDuJour(), faibles = pointsFaibles(), dus = aReviser();
  const nbEx = plan.file.filter(estExercice).length;
  const fait = PROG.sessionJour === aujourdhui();
  const xpJour = PROG.jours[aujourdhui()] || 0, obj = PROG.objectif;
  const ratio = Math.min(1, xpJour / obj), C = 2 * Math.PI * 80;
  const message = fait ? "Session du jour terminée ✅" : xpJour >= obj ? "Objectif atteint 🎉" : xpJour ? "Continue comme ça !" : "Prêt pour ta session du jour ?";
  const tip = pick(SCIENCE);
  const lancer = () => nbEx ? demarrer("jour", plan.file, { titre: "Session du jour", partie: plan.partie }) : accueil();
  afficher(`
    <section class="hero">
      <div class="anneau">
        <svg width="190" height="190" viewBox="0 0 190 190"><circle cx="95" cy="95" r="80" stroke="rgba(255,255,255,.15)" stroke-width="16" fill="none"/>
          <circle cx="95" cy="95" r="80" stroke="url(#g)" stroke-width="16" fill="none" stroke-linecap="round"
            stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - ratio)}" style="transition:stroke-dashoffset 1s"/>
          <defs><linearGradient id="g"><stop offset="0" stop-color="#22d3a6"/><stop offset="1" stop-color="#ffc83d"/></linearGradient></defs></svg>
        <div class="centre"><div><strong>${xpJour}</strong><small>/ ${obj} XP aujourd'hui</small></div></div>
      </div>
      <div>
        <h1>${message}</h1>
        <p class="sous-hero">${fait ? "Tu peux en refaire une : elle sera différente." : "Un mélange de tout, pour progresser partout à la fois."} · ${nbEx} exercices · environ ${Math.max(5, Math.round(nbEx * 0.45))} min</p>
        ${(() => { const v = prochainNiveau(); if (!v) return ""; const pct = Math.round(100 * avancement(v));
          return `<button class="ligne-niveau" data-go="niveau">🎓 <b>${niveauActuel() || "Pré-A1"}</b> → ${v} <span class="mini-barre"><span style="width:${pct}%"></span></span> ${pct} %</button>`; })()}
        <div class="puces">${plan.resume.map(([ic, t, s]) => `<div class="puce"><span>${ic}</span><div><b>${esc(t)}</b><small>${esc(s)}</small></div></div>`).join("")}</div>
        <div class="actions">
          <button class="btn vert grand" id="go">▶ ${fait ? "Encore une session" : "Commencer ma session du jour"}</button>
          ${faibles.length ? `<button class="btn gris" id="go-faibles">🎯 Points faibles (${faibles.length})</button>` : ""}
          ${dus.length ? `<button class="btn gris" id="go-rev">🔄 Révisions seules (${dus.length})</button>` : ""}
        </div>
      </div>
    </section>
    <div class="grille3">
      <div class="tuile" data-go="carte"><span class="ic">🗺️</span><h3>Leçons</h3><p>${nbLeconsFaites()} / ${LECONS.length} terminées · grammaire et phrases utiles</p>
        <div class="barre"><div style="width:${100 * nbLeconsFaites() / LECONS.length}%"></div></div></div>
      <div class="tuile" data-go="vocabulaire"><span class="ic">📚</span><h3>Vocabulaire</h3><p>${motsMaitrises()} mots maîtrisés · ${motsVus()} / ${VOCAB.length} découverts</p>
        <div class="barre verte"><div style="width:${100 * motsVus() / VOCAB.length}%"></div></div></div>
      <div class="tuile" data-go="verbes"><span class="ic">🔁</span><h3>Verbes irréguliers</h3><p>${verbesMaitrises()} maîtrisés · ${verbesVus()} / ${VERBES.length} découverts${PROG.recordChrono ? ` · record ⏱ ${PROG.recordChrono}` : ""}</p>
        <div class="barre verte"><div style="width:${100 * verbesVus() / VERBES.length}%"></div></div></div>
      <div class="tuile" data-go="histoires"><span class="ic">📖</span><h3>Histoires</h3><p>${Object.keys(PROG.histoires).length} / ${HISTOIRES.length} lues · lire et écouter</p>
        <div class="barre"><div style="width:${100 * Object.keys(PROG.histoires).length / Math.max(1, HISTOIRES.length)}%"></div></div></div>
      <div class="tuile" data-go="cine"><span class="ic">🎬</span><h3>Ciné-club</h3><p>${Object.keys(PROG.scenes).length} / ${CINE.length} scènes vues · traduire et compléter</p>
        <div class="barre"><div style="width:${100 * Object.keys(PROG.scenes).length / Math.max(1, CINE.length)}%"></div></div></div>
      <div class="tuile tuile-niveau" data-go="niveau"><span class="ic">🎓</span><h3>Mon niveau : ${niveauActuel() || "Pré-A1"}</h3><p>${prochainNiveau() ? `${Math.round(100 * avancement(prochainNiveau()))} % vers ${prochainNiveau()} · encore ${Math.max(0, seuilMots(prochainNiveau()) - VOCAB.filter(v => motAcquis(v.id)).length)} mots` : "Niveau maximum atteint 👑"}</p>
        <div class="barre"><div style="width:${prochainNiveau() ? 100 * avancement(prochainNiveau()) : 100}%"></div></div></div>
      <div class="tuile tuile-classement" data-go="classement"><span class="ic">🏆</span><h3>Classement</h3><p>${PROG.profil?.groupe ? `Groupe ${esc(PROG.profil.groupe)} · ${xpSemaine()} XP cette semaine` : "Compare ta progression avec ta famille ou tes amis"}</p>
        <div class="barre"><div style="width:${PROG.profil?.groupe ? 100 : 0}%"></div></div></div>
      <div class="tuile" data-go="mesMots"><span class="ic">📊</span><h3>Mes mots</h3><p>${Object.values(PROG.items).filter(s => s.s >= 3).length} bien connus · ${Object.values(PROG.items).filter(s => s.n).length} appris au total</p>
        <div class="barre verte"><div style="width:${100 * Object.values(PROG.items).filter(s => s.n).length / Math.max(1, VOCAB.length + VERBES.length + LECONS.length * 10 + CINE.length * 6)}%"></div></div></div>
      <div class="tuile" data-go="progres"><span class="ic">🏅</span><h3>Progrès et badges</h3><p>${PROG.badges.length} / ${BADGES.length} badges · meilleure série ${PROG.meilleureSerie} j</p>
        <div class="barre"><div style="width:${100 * PROG.badges.length / BADGES.length}%"></div></div></div>
    </div>
    ${cloudConfigure() && !COMPTE ? `<button class="bandeau-sync" id="go-sync">☁️ <span><b>Synchronise ta progression entre ton PC et ton iPhone</b><small>Connecte-toi une fois sur chaque appareil, et tout se met à jour automatiquement.</small></span> →</button>` : ""}
    <div class="astuce-science"><span class="ic">${tip.ic}</span>
      <p><b>${esc(tip.titre)}.</b> ${esc(tip.p)} <i>(${esc(tip.etude)})</i></p>
      <button class="lien" data-go="science">Pourquoi ça marche ? →</button></div>
  `, false);
  $("#go").onclick = lancer;
  if ($("#go-faibles")) $("#go-faibles").onclick = lancerFaibles;
  if ($("#go-rev")) $("#go-rev").onclick = () => lancerRevision();
  if ($("#go-sync")) $("#go-sync").onclick = () => { progres(); setTimeout(() => $("#sync")?.scrollIntoView({ behavior: "smooth" }), 80); };
  gestionTouches = e => { if (e.key === "Enter") lancer(); };
}

// ------------------------------------------------------------------ carte des leçons
function carte() {
  let html = `<h1>Carte des leçons</h1><p class="sous">Chaque leçon a 2 parties courtes. Une partie réussie reste acquise, et les 2 parties débloquent la leçon suivante. La session du jour te fait avancer automatiquement ici. Rejoue les leçons pour les 3 étoiles : les exercices deviennent plus difficiles à mesure que tu progresses.</p>`;
  MONDES.forEach((m, mi) => {
    const ls = LECONS.filter(l => l.mi === mi);
    html += `<section class="monde"><div class="monde-titre"><h2>${esc(m.monde)}</h2><small>${ls.filter(l => etoiles(l.i)).length} / ${ls.length}</small></div><div class="chemin">`;
    ls.forEach((l, k) => {
      const ouvert = debloquee(l.i), et = etoiles(l.i), actuel = ouvert && !et;
      const decal = [0, 90, 140, 90, 0, -90, -140, -90][k % 8];
      html += `<div class="noeud-ligne" style="transform:translateX(${decal}px)">
        <div class="noeud ${et ? "fait" : actuel ? "actuel" : ouvert ? "" : "verrou"}" ${ouvert ? `data-lecon="${l.i}"` : ""}>${ouvert ? (et ? "★" : l.i + 1) : "🔒"}</div>
        <div class="noeud-info"><h4>${esc(l.titre)}</h4>
          ${ouvert ? `<div class="parties">${[0, 1].map(k => { const e = etoilesPartie(l.i, k);
            return `<button class="partie-pill ${e ? "ok" : ""}" data-lecon="${l.i}" data-partie="${k}">Partie ${k + 1} <span>${"★".repeat(e)}${"☆".repeat(3 - e)}</span></button>`; }).join("")}</div>`
            : `<small>Termine la leçon précédente</small>`}</div></div>`;
    });
    html += `</div></section>`;
  });
  afficher(html);
  $$("[data-lecon]").forEach(n => n.onclick = e => { e.stopPropagation(); lancerLecon(+n.dataset.lecon, n.dataset.partie === undefined ? undefined : +n.dataset.partie); });
}

// ------------------------------------------------------------------ histoires
function histoires() {
  afficher(`<h1>Histoires</h1>
    <p class="sous">De courtes histoires à ton niveau, lues par une voix naturelle. Clique sur 🇫🇷 pour voir la traduction d'une phrase, puis réponds aux questions. La session du jour t'en propose une nouvelle chaque jour.</p>
    <div class="grille-packs">${HISTOIRES.map((h, s) => { const r = PROG.histoires[s];
      return `<div class="tuile pack" data-histoire="${s}"><span class="ic">${h.icone}</span><h3>${esc(h.titre)}</h3>
        <p>Niveau ${esc(h.niveau)} · ${h.phrases.length} phrases</p>
        <div class="chiffres"><span>${r ? `✅ Lue · ${r.score} / ${h.questions.length} bonnes réponses` : "Pas encore lue"}</span></div></div>`; }).join("")}</div>`);
  $$("[data-histoire]").forEach(t => t.onclick = () => lancerHistoire(+t.dataset.histoire));
}

// ------------------------------------------------------------------ ciné-club
function cine() {
  afficher(`<h1>🎬 Ciné-club</h1>
    <p class="sous">Des scènes originales dans le style des grands genres de films et séries, jouées par plusieurs voix, avec sous-titres. Regarde la scène, traduis les répliques en français, puis complète les phrases à trous. Les répliques reviennent ensuite dans tes révisions, de plus en plus difficiles (mot manquant à écrire, puis dictée).</p>
    <div class="grille-affiches">${CINE.map((sc, s) => { const v = PROG.scenes[s], ids = idsScene(s), conn = ids.filter(id => (PROG.items[id]?.s || 0) >= 3).length;
      return `<div class="affiche" data-scene="${s}" style="--couleur:${sc.couleur}">
        <div class="haut-affiche"><span>${sc.icone}</span></div>
        <div class="bas-affiche"><small>${esc(sc.genre)}</small><h3>${esc(sc.titre)}</h3>
          <p>${v ? `✅ Vue · ${conn} / ${ids.length} répliques bien connues` : `${ids.length} répliques · ${Object.keys(sc.persos).length} personnages`}</p></div></div>`; }).join("")}</div>`);
  $$("[data-scene]").forEach(a => a.onclick = () => lancerScene(+a.dataset.scene));
}

// ------------------------------------------------------------------ mes mots : taux de complétion
const STATUTS = { connu: ["Bien connus", "var(--vert)"], encours: ["En cours d'apprentissage", "var(--orange)"], nouveau: ["Pas encore appris", "#3a4170"] };
const statut = id => { const s = PROG.items[id]; return !s?.n ? "nouveau" : s.s >= 3 ? "connu" : "encours"; };
const fragile = id => { const s = PROG.items[id]; return !!s?.n && (proba(id) < 0.5 || (s.ko >= 2 && (s.c || 0) < 3)); };
function collection(onglet) {   // éléments + groupes de l'onglet choisi
  if (onglet === "verbes") return { titre: "verbes irréguliers", groupes: VPACKS.map(p => ({ nom: `${p.icone} ${p.pack}`, ids: p.ids })),
    lignes: VERBES.map(v => ({ id: v.id, en: troisFormes(v), fr: v.fr })) };
  if (onglet === "phrases") return { titre: "phrases des leçons", groupes: LECONS.map(l => ({ nom: `${l.i + 1}. ${l.titre}`, ids: l.phrases.map((_, j) => `p-${l.i}-${j}`) })),
    lignes: LECONS.flatMap(l => l.phrases.map((p, j) => ({ id: `p-${l.i}-${j}`, en: p[0] === "fr-en" ? p[2] : p[1], fr: p[0] === "fr-en" ? p[1] : p[2] }))) };
  if (onglet === "cine") return { titre: "répliques de films", groupes: CINE.map((sc, s) => ({ nom: `${sc.icone} ${sc.titre}`, ids: idsScene(s) })),
    lignes: CINE.flatMap((sc, s) => sc.lignes.map((l, i) => ({ id: `c-${s}-${i}`, en: l[1], fr: l[2] }))) };
  return { titre: "mots", groupes: PACKS.map(p => ({ nom: `${p.icone} ${p.pack}`, ids: p.ids })), lignes: VOCAB.map(v => ({ id: v.id, en: v.en, fr: v.fr })) };
}
function mesMots(onglet = "mots", filtre = "tous") {
  const C = collection(onglet), total = C.lignes.length;
  const compte = { connu: 0, encours: 0, nouveau: 0 };
  C.lignes.forEach(l => compte[statut(l.id)]++);
  const fragiles = C.lignes.filter(l => fragile(l.id));
  const appris = compte.connu + compte.encours, pct = n => Math.round(100 * n / Math.max(1, total));
  // anneau en 3 segments
  const R = 70, P = 2 * Math.PI * R;
  let decalage = 0;
  const segments = ["connu", "encours", "nouveau"].map(k => {
    const long = P * compte[k] / Math.max(1, total);
    const seg = `<circle cx="90" cy="90" r="${R}" fill="none" stroke="${STATUTS[k][1]}" stroke-width="22" stroke-dasharray="${long} ${P - long}" stroke-dashoffset="${-decalage}"/>`;
    decalage += long;
    return seg;
  }).join("");
  const onglets = [["mots", "📚 Mots"], ["verbes", "🔁 Verbes"], ["phrases", "📘 Phrases"], ["cine", "🎬 Répliques"]];
  const filtres = [["tous", `Tous (${total})`], ["connu", `Bien connus (${compte.connu})`], ["encours", `En cours (${compte.encours})`], ["nouveau", `Pas encore appris (${compte.nouveau})`], ["fragile", `⚠️ Fragiles (${fragiles.length})`]];
  const visibles = C.lignes.filter(l => filtre === "tous" || (filtre === "fragile" ? fragile(l.id) : statut(l.id) === filtre));
  afficher(`<h1>📊 Mes mots</h1>
    <p class="sous">Ton taux de complétion : ce que tu as appris, ce que tu connais bien et ce qu'il te reste à découvrir.</p>
    <div class="onglets">${onglets.map(([k, n]) => `<button class="onglet ${k === onglet ? "on" : ""}" data-onglet="${k}">${n}</button>`).join("")}</div>
    <div class="bilan">
      <div class="donut"><svg width="180" height="180" style="transform:rotate(-90deg)">${segments}</svg>
        <div class="centre"><strong>${pct(appris)} %</strong><small>appris</small></div></div>
      <div class="legende">
        <h2 style="margin-top:0">${appris} / ${total} ${C.titre} ${onglet === "phrases" || onglet === "cine" ? "apprises" : "appris"}</h2>
        ${["connu", "encours", "nouveau"].map(k => `<div class="leg"><span class="pt" style="background:${STATUTS[k][1]}"></span><b>${compte[k]}</b> ${STATUTS[k][0]} <small>(${pct(compte[k])} %)</small></div>`).join("")}
        <div class="leg"><span class="pt" style="background:var(--rouge)"></span><b>${fragiles.length}</b> fragiles : déjà vus, mais ta mémoire faiblit ou tu les rates souvent</div>
        <p class="sous" style="margin:10px 0 0">« Bien connu » = réussi plusieurs fois, à plusieurs jours d'écart.</p>
        ${fragiles.length ? `<button class="btn rouge" id="fragiles" style="margin-top:12px">⚠️ Réviser mes ${Math.min(10, fragiles.length)} plus fragiles</button>` : ""}
      </div>
    </div>
    <h2>Par ${onglet === "phrases" ? "leçon" : onglet === "cine" ? "scène" : "pack"}</h2>
    <div class="groupes">${C.groupes.map(g => { const c = { connu: 0, encours: 0, nouveau: 0 }; g.ids.forEach(id => c[statut(id)]++);
      return `<div class="groupe"><span class="nom-g">${esc(g.nom)}</span><div class="barre-empilee">${["connu", "encours", "nouveau"].map(k => `<div style="width:${100 * c[k] / g.ids.length}%;background:${STATUTS[k][1]}" title="${STATUTS[k][0]} : ${c[k]}"></div>`).join("")}</div><small>${c.connu + c.encours} / ${g.ids.length}</small></div>`; }).join("")}</div>
    <h2 style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">Liste <input class="recherche" id="recherche" placeholder="🔍 Rechercher (anglais ou français)…"></h2>
    <div class="filtres">${filtres.map(([k, n]) => `<button class="filtre ${k === filtre ? "on" : ""}" data-filtre="${k}">${esc(n)}</button>`).join("")}</div>
    <div class="liste-mots" id="liste">${visibles.map(l => { const st = statut(l.id), p = PROG.items[l.id]?.n ? Math.round(100 * proba(l.id)) : null;
      return `<div class="ligne-mot" data-id="${l.id}" data-txt="${esc((l.en + " " + l.fr).toLowerCase())}">
        <span class="pt" style="background:${fragile(l.id) ? "var(--rouge)" : STATUTS[st][1]}"></span>
        <div class="txt-mot"><b>${esc(l.en)}</b><small>${esc(l.fr)}</small></div>
        <div class="memoire" title="Probabilité de t'en souvenir maintenant">${p === null ? "<small>pas encore vu</small>" : `<div class="barre"><div style="width:${p}%;background:${p >= 80 ? "var(--vert)" : p >= 50 ? "var(--orange)" : "var(--rouge)"}"></div></div><small>mémoire ${p} %</small>`}</div>
        <button class="hp-mini" title="Écouter">🔊</button></div>`; }).join("") || `<p class="sous">Rien dans cette catégorie.</p>`}</div>`);
  $$("[data-onglet]").forEach(b => b.onclick = () => mesMots(b.dataset.onglet, "tous"));
  $$("[data-filtre]").forEach(b => b.onclick = () => mesMots(onglet, b.dataset.filtre));
  $("#recherche").oninput = e => { const q = e.target.value.toLowerCase().trim(); $$(".ligne-mot").forEach(r => r.style.display = !q || r.dataset.txt.includes(q) ? "" : "none"); };
  $$(".ligne-mot").forEach(r => r.onclick = () => parler(texteAnglais(r.dataset.id), false, voixDe(r.dataset.id)));
  if ($("#fragiles")) $("#fragiles").onclick = () => {
    const ids = fragiles.map(l => l.id).sort((a, b) => proba(a) - proba(b)).slice(0, 10);
    demarrer("fragiles", sequenceNouveaux(ids, undefined, null, "fiche").map(e => e.fiche ? e : { id: e.id }), { titre: "Mots fragiles" });
  };
}

// ------------------------------------------------------------------ vocabulaire
function vocabulaire(onglet = niveauVise()) {
  const packsNiv = PACKS.filter(p => p.niveau === onglet);
  const idsNiv = packsNiv.flatMap(p => p.ids);
  afficher(`<h1>Vocabulaire</h1>
    <p class="sous">${VOCAB.length} mots classés du niveau A1 au niveau C2, des plus fréquents aux plus rares. Chaque mot passe par 4 étapes : reconnaître → retrouver → écouter → écrire. La session du jour te les fait découvrir dans l'ordre.</p>
    <div class="onglets">${NIVEAUX.map(n => { const ids = PACKS.filter(p => p.niveau === n).flatMap(p => p.ids);
      return `<button class="onglet ${n === onglet ? "on" : ""}" data-niv="${n}">${INFOS_NIVEAUX[n].ic} ${n} <small>${ids.filter(motAcquis).length}/${ids.length}</small></button>`; }).join("")}</div>
    <p class="sous"><b>${INFOS_NIVEAUX[onglet].nom}</b> · ${idsNiv.filter(id => PROG.items[id]?.n).length} / ${idsNiv.length} découverts · ${idsNiv.filter(motAcquis).length} acquis${accessible(onglet) ? "" : " · 🔒 La session du jour proposera ces mots quand tu viseras ce niveau (tu peux déjà les ouvrir ici)."}</p>
    <div class="grille-packs">${packsNiv.map(p => {
      const vus = p.ids.filter(id => PROG.items[id]?.n).length, mait = p.ids.filter(id => (PROG.items[id]?.s || 0) >= 3).length;
      return `<div class="tuile pack" data-pack="${p.pi}"><span class="ic">${p.icone}</span><h3>${esc(p.pack)}</h3>
        <div class="chiffres"><span>${vus} / ${p.ids.length} découverts</span><span>${mait} maîtrisés</span></div>
        <div class="barre verte"><div style="width:${100 * mait / p.ids.length}%"></div></div>
        <div class="barre" style="margin-top:6px;height:6px"><div style="width:${100 * vus / p.ids.length}%"></div></div></div>`;
    }).join("")}</div>`);
  $$("[data-niv]").forEach(b => b.onclick = () => vocabulaire(b.dataset.niv));
  $$("[data-pack]").forEach(t => t.onclick = () => lancerPack(+t.dataset.pack));
}

// ------------------------------------------------------------------ classement
const ONGLETS_CLASSEMENT = {
  semaine: { nom: "📅 Cette semaine", valeur: l => l.xp_semaine, unite: "XP", tri: (a, b) => b.xp_semaine - a.xp_semaine },
  total: { nom: "⚡ XP total", valeur: l => l.xp, unite: "XP", tri: (a, b) => b.xp - a.xp },
  niveau: { nom: "🎓 Niveau", valeur: l => `${l.niveau} · ${l.avancement} %`, unite: "", tri: (a, b) => (NIVEAUX.indexOf(b.niveau) - NIVEAUX.indexOf(a.niveau)) || b.avancement - a.avancement },
  serie: { nom: "🔥 Série", valeur: l => l.serie, unite: "jours", tri: (a, b) => b.serie - a.serie },
  mots: { nom: "📚 Mots acquis", valeur: l => l.mots, unite: "mots", tri: (a, b) => b.mots - a.mots },
};
function ilYa(iso) {
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  return min < 2 ? "à l'instant" : min < 60 ? `il y a ${min} min` : min < 1440 ? `il y a ${Math.round(min / 60)} h` : `il y a ${Math.round(min / 1440)} j`;
}
function formulaireProfil(modification) {
  const p = PROG.profil || {};
  return `<div class="carte-vise formulaire-profil">
      <h2 style="margin-top:0">${modification ? "Modifier mon profil" : "Crée ton profil de joueur"}</h2>
      <p class="sous">Ton pseudo et ton avatar seront visibles par les membres de ton groupe, et uniquement par eux.</p>
      <input class="saisie" id="pseudo" maxlength="20" placeholder="Ton pseudo (ex. : Tom, Maman…)" value="${esc(p.pseudo || "")}">
      <div class="grille-avatars">${AVATARS.map(a => `<button class="avatar-choix ${a === (p.avatar || AVATARS[0]) ? "on" : ""}" data-avatar="${a}">${a}</button>`).join("")}</div>
      ${modification ? `<div class="ligne-reglage"><button class="btn vert" id="profil-ok">Enregistrer</button><button class="btn gris" id="profil-annuler">Annuler</button><button class="btn rouge" id="quitter-groupe">Quitter le groupe</button></div>`
        : `<div class="choix-groupe">
            <div><b>Tu crées le groupe</b><small>Tu recevras un code à donner aux autres.</small><button class="btn vert" id="creer-groupe">✨ Créer un groupe</button></div>
            <div><b>On t'a donné un code</b><small>Entre-le pour rejoindre le groupe.</small><input class="saisie" id="code-groupe" placeholder="EQ-XXXXXX" maxlength="20"><button class="btn" id="rejoindre-groupe">Rejoindre</button></div>
          </div>`}
      <small id="profil-msg" class="sous"></small>
    </div>`;
}
async function classement(onglet = "semaine", edition = false) {
  if (!cloudConfigure() || !COMPTE) {
    afficher(`<h1>🏆 Classement</h1><div class="carte-vise"><h2 style="margin-top:0">Connecte-toi d'abord</h2>
      <p class="sous">Le classement utilise ton compte de synchronisation. Connecte-toi (ou crée ton compte) dans Progrès → Synchronisation.</p>
      <button class="btn vert" id="aller-sync">☁️ Me connecter</button></div>`);
    $("#aller-sync").onclick = () => { progres(); setTimeout(() => $("#sync")?.scrollIntoView({ behavior: "smooth" }), 80); };
    return;
  }
  if (!PROG.profil?.groupe || edition) {
    afficher(`<h1>🏆 Classement</h1>${formulaireProfil(edition)}`);
    let avatar = PROG.profil?.avatar || AVATARS[0];
    $$("[data-avatar]").forEach(b => b.onclick = () => { avatar = b.dataset.avatar; $$(".avatar-choix").forEach(x => x.classList.toggle("on", x === b)); son("clic"); });
    const valider = async groupe => {
      const pseudo = $("#pseudo").value.trim();
      if (!pseudo) { $("#profil-msg").textContent = "⚠️ Choisis un pseudo."; return; }
      if (!/^[A-Z0-9-]{4,20}$/.test(groupe)) { $("#profil-msg").textContent = "⚠️ Code de groupe invalide."; return; }
      PROG.profil = { ...(PROG.profil || {}), pseudo, avatar, groupe };
      $("#profil-msg").textContent = "⏳ Enregistrement…";
      try { await jetonValide(); await publierClassement(); sauver(); classement(onglet); }
      catch (e) {
        $("#profil-msg").textContent = /classement|relation|does not exist|404/i.test(e.message + e.statut)
          ? "⚠️ Le classement n'est pas encore activé dans Supabase (script classement_setup.sql à exécuter)." : "⚠️ " + traduireErreur(e.message);
      }
    };
    if ($("#creer-groupe")) $("#creer-groupe").onclick = () => valider(nouveauCodeGroupe());
    if ($("#rejoindre-groupe")) $("#rejoindre-groupe").onclick = () => valider($("#code-groupe").value.trim().toUpperCase());
    if ($("#profil-ok")) $("#profil-ok").onclick = () => valider(PROG.profil.groupe);
    if ($("#profil-annuler")) $("#profil-annuler").onclick = () => classement(onglet);
    if ($("#quitter-groupe")) $("#quitter-groupe").onclick = async () => {
      if (!confirm("Quitter le groupe ? Tu disparaîtras du classement (ta progression, elle, est conservée).")) return;
      await quitterGroupe(); classement();
    };
    return;
  }
  afficher(`<h1>🏆 Classement</h1><p class="sous">⏳ Chargement du classement…</p>`);
  let lignes;
  try { await publierClassement(); lignes = await lireClassement(); }
  catch (e) { $(".contenu .sous").textContent = "⚠️ Impossible de charger le classement : " + traduireErreur(e.message); return; }
  const O = ONGLETS_CLASSEMENT[onglet];
  lignes.sort(O.tri);
  const moi = lignes.findIndex(l => l.user_id === COMPTE.user_id);
  const medaille = i => ["🥇", "🥈", "🥉"][i] || `${i + 1}`;
  let duel = "";
  if (lignes.length > 1 && onglet !== "niveau") {
    const v = l => +O.valeur(l) || 0;
    duel = moi === 0 ? `👑 Tu es en tête${v(lignes[0]) > v(lignes[1]) ? ` avec ${v(lignes[0]) - v(lignes[1])} ${O.unite} d'avance sur ${esc(lignes[1].pseudo)}` : ""} !`
      : `💪 Encore ${v(lignes[moi - 1]) - v(lignes[moi]) + 1} ${O.unite} pour dépasser ${esc(lignes[moi - 1].pseudo)} !`;
  }
  afficher(`<h1>🏆 Classement</h1>
    <div class="code-groupe-carte"><div><small>Code de ton groupe</small><strong>${esc(PROG.profil.groupe)}</strong>
      <span>Donne-le aux personnes que tu veux affronter : elles l'entrent dans « Rejoindre ».</span></div>
      <div class="ligne-reglage"><button class="btn gris" id="copier-code">📋 Copier</button><button class="btn gris" id="modifier-profil">${PROG.profil.avatar} Mon profil</button></div></div>
    <div class="onglets">${Object.entries(ONGLETS_CLASSEMENT).map(([k, o]) => `<button class="onglet ${k === onglet ? "on" : ""}" data-onglet-c="${k}">${o.nom}</button>`).join("")}</div>
    ${duel ? `<p class="duel">${duel}</p>` : ""}
    <div class="liste-classement">${lignes.map((l, i) => `<div class="joueur ${l.user_id === COMPTE.user_id ? "moi" : ""} ${i < 3 ? "podium-" + (i + 1) : ""}">
        <span class="rang-c">${medaille(i)}</span><span class="avatar-c">${esc(l.avatar)}</span>
        <div class="infos-c"><b>${esc(l.pseudo)}${l.user_id === COMPTE.user_id ? " <em>(toi)</em>" : ""}</b>
          <small>🎓 ${esc(l.niveau)} · 🔥 ${l.serie} j · 📚 ${l.mots} mots · 📘 ${l.lecons} leçons · actif ${ilYa(l.updated_at)}</small></div>
        <div class="valeur-c"><strong>${esc(String(O.valeur(l)))}</strong><small>${O.unite}</small></div></div>`).join("")}</div>
    ${lignes.length < 2 ? `<p class="sous" style="margin-top:14px">Tu es seul pour l'instant : partage le code <b>${esc(PROG.profil.groupe)}</b> pour que les autres te rejoignent.</p>` : ""}
    <p class="sous" style="margin-top:14px">Le classement « Cette semaine » repart de zéro chaque lundi. Les scores se mettent à jour à chaque synchronisation.
      <button class="lien" id="rafraichir-c">🔄 Actualiser</button></p>`);
  $$("[data-onglet-c]").forEach(b => b.onclick = () => classement(b.dataset.ongletC));
  $("#modifier-profil").onclick = () => classement(onglet, true);
  $("#rafraichir-c").onclick = () => classement(onglet);
  $("#copier-code").onclick = async () => {
    try { await navigator.clipboard.writeText(PROG.profil.groupe); toast("📋", "Code copié", PROG.profil.groupe); }
    catch (e) { toast("📋", "Code du groupe", PROG.profil.groupe); }
  };
}

// ------------------------------------------------------------------ mon niveau
function niveau() {
  const actuel = niveauActuel(), vise = prochainNiveau();
  const I = actuel ? INFOS_NIVEAUX[actuel] : { nom: "Premiers pas", ic: "🥚", couleur: "#9aa3d0", desc: "Tu poses les bases. Prochaine étape : le niveau A1 !" };
  const rythme = rythmeMotsParJour();
  const s = PROG.stats, tot = s.bonnes + s.mauvaises;
  let blocVise = "";
  if (vise) {
    const crit = criteresPalier(vise), pct = Math.round(100 * avancement(vise));
    const resteMots = Math.max(0, crit[0].cible - crit[0].actuel);
    const estimation = resteMots && rythme > 0 ? Math.ceil(resteMots / rythme) : null;
    blocVise = `<div class="carte-vise" style="--couleur:${INFOS_NIVEAUX[vise].couleur}">
      <div class="entete-vise"><div><small>Prochain palier</small><h2>${INFOS_NIVEAUX[vise].ic} ${vise} · ${INFOS_NIVEAUX[vise].nom}</h2></div><strong>${pct} %</strong></div>
      <div class="barre grosse"><div style="width:${pct}%"></div></div>
      <div class="criteres">${crit.map(c => { const ok = c.actuel >= c.cible, r = Math.max(0, c.cible - c.actuel);
        return `<div class="critere ${ok ? "ok" : ""}"><span class="ic">${ok ? "✅" : c.ic}</span><div class="txt-c"><b>${c.libelle}</b>
          <div class="barre"><div style="width:${Math.min(100, 100 * c.actuel / c.cible)}%"></div></div>
          <small>${Math.min(c.actuel, c.cible)} / ${c.cible} ${c.unite}${ok ? " · validé" : ` · encore <b>${r}</b>`}</small></div></div>`; }).join("")}</div>
      <p class="sous" style="margin:12px 0 0">${resteMots ? `Il te reste <b>${resteMots} mots</b> à acquérir pour ${vise}.` : "Objectif de vocabulaire atteint pour ce palier !"}
        ${estimation ? ` À ton rythme actuel (${rythme.toFixed(1)} mots acquis par jour), environ <b>${estimation} jour${estimation > 1 ? "s" : ""}</b>.` : resteMots ? " Joue quelques jours pour que j'estime le temps restant." : ""}</p>
      <p class="sous" style="margin:6px 0 0">Ce que tu sauras faire en ${vise} : ${INFOS_NIVEAUX[vise].peux.map(esc).join(" · ")}.</p>
    </div>`;
  }
  const jours = Object.keys(PROG.suivi || {}).sort().slice(-30);
  const maxA = Math.max(10, ...jours.map(j => PROG.suivi[j].acquis));
  afficher(`<h1>🎓 Mon niveau</h1>
    <div class="hero-niveau" style="--couleur:${I.couleur}">
      <div class="medaille grande">${I.ic}<span>${actuel || "Pré-A1"}</span></div>
      <div><small>Ton niveau actuel</small><h2>${actuel ? `${actuel} · ${I.nom}` : "Pré-A1 · Premiers pas"}</h2><p>${esc(I.desc)}</p>
        ${actuel ? `<p class="sous" style="margin:6px 0 0">Atteint le ${new Date(PROG.paliers[actuel] + "T12:00").toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}</p>` : ""}</div>
    </div>
    ${blocVise || `<div class="carte-vise"><h2>👑 Tu as atteint le niveau maximum de l'appli !</h2><p class="sous">Continue à réviser et, surtout, à lire, regarder et parler en anglais.</p></div>`}
    <h2>Ton parcours A1 → C2</h2>
    <div class="parcours">${NIVEAUX.map(n => { const atteint = PROG.paliers?.[n], courant = n === vise;
      return `<div class="etape-p ${atteint ? "atteint" : courant ? "courant" : ""}" style="--couleur:${INFOS_NIVEAUX[n].couleur}">
        <div class="pastille-p">${atteint ? INFOS_NIVEAUX[n].ic : courant ? Math.round(100 * avancement(n)) + "%" : "🔒"}</div>
        <b>${n}</b><small>${INFOS_NIVEAUX[n].nom}</small>
        <small>${atteint ? new Date(atteint + "T12:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) : `${seuilMots(n)} mots`}</small></div>`; }).join("")}</div>
    <h2>Tes statistiques</h2>
    <div class="grille-stats">
      <div class="stat"><strong style="color:var(--vert)">${VOCAB.filter(v => motAcquis(v.id)).length}</strong><span>Mots acquis (sur ${VOCAB.length})</span></div>
      <div class="stat"><strong style="color:var(--or)">${Object.values(PROG.items).filter(x => x.s >= 3).length}</strong><span>Éléments bien connus</span></div>
      <div class="stat"><strong style="color:var(--bleu)">${VERBES.filter(v => motAcquis(v.id)).length}</strong><span>Verbes irréguliers acquis</span></div>
      <div class="stat"><strong style="color:var(--violet)">${nbLeconsFaites()} / ${LECONS.length}</strong><span>Leçons de grammaire</span></div>
      <div class="stat"><strong>${Object.keys(PROG.histoires).length} / ${HISTOIRES.length}</strong><span>Histoires lues</span></div>
      <div class="stat"><strong>${Object.keys(PROG.scenes).length} / ${CINE.length}</strong><span>Scènes de film vues</span></div>
      <div class="stat"><strong>${s.minutes ? (s.minutes >= 60 ? Math.floor(s.minutes / 60) + " h " + (s.minutes % 60) : s.minutes + " min") : "—"}</strong><span>Temps d'entraînement</span></div>
      <div class="stat"><strong>${tot ? Math.round(100 * s.bonnes / tot) : 0} %</strong><span>Réponses justes (${tot})</span></div>
    </div>
    ${jours.length > 1 ? `<h2>Mots acquis au fil des jours</h2><div class="graphe">${jours.map(j => `<div class="col" title="${PROG.suivi[j].acquis} mots acquis"><div class="b ok" style="height:${100 * PROG.suivi[j].acquis / maxA}%"></div><small>${j.slice(8)}</small></div>`).join("")}</div>` : ""}
    <p class="sous" style="margin-top:20px">ℹ️ Ces paliers sont une estimation fondée sur le vocabulaire, la grammaire, la lecture et l'écoute travaillés dans l'appli, alignée sur les niveaux européens (CECRL). Pour un niveau officiel, il existe des tests (Cambridge, TOEIC, IELTS). À partir de B2, regarder des séries, lire et parler en anglais compte autant que l'appli.</p>`);
}

// ------------------------------------------------------------------ verbes irréguliers
function verbes() {
  const pastille = id => { const s = PROG.items[id]?.s || 0, n = PROG.items[id]?.n; return !n ? "" : s >= 3 ? "ok" : "moyen"; };
  afficher(`<h1>Verbes irréguliers</h1>
    <p class="sous">Les 100 verbes irréguliers les plus utilisés, à connaître par cœur. Chaque verbe passe par 4 étapes : prétérit en QCM → participe en QCM → prétérit à écrire → les deux formes à écrire. Ils reviennent ensuite dans tes révisions du jour, au bon moment.</p>
    <div class="carte-chrono">
      <div class="ic">⏱️</div>
      <div style="flex:1"><h3>Défi 60 secondes</h3><p>Écris un maximum de formes en une minute. ${PROG.recordChrono ? `Ton record : <b>${PROG.recordChrono}</b>` : "Établis ton premier record !"}</p></div>
      <button class="btn vert grand" id="chrono">▶ Jouer</button>
    </div>
    <h2>Packs (du plus courant au plus rare)</h2>
    <div class="grille-packs">${VPACKS.map(p => {
      const vus = p.ids.filter(id => PROG.items[id]?.n).length, mait = p.ids.filter(id => (PROG.items[id]?.s || 0) >= 3).length;
      return `<div class="tuile pack" data-vpack="${p.pi}"><span class="ic">${p.icone}</span><h3>${esc(p.pack)}</h3>
        <p>${p.ids.slice(0, 4).map(id => esc(IBYID[id].base)).join(", ")}…</p>
        <div class="chiffres"><span>${vus} / ${p.ids.length} découverts</span><span>${mait} maîtrisés</span></div>
        <div class="barre verte"><div style="width:${100 * mait / p.ids.length}%"></div></div></div>`;
    }).join("")}</div>
    <h2 style="display:flex;align-items:center;gap:14px">Tableau complet <button class="btn gris" id="cacher" style="padding:8px 16px;font-size:14px">🙈 Cacher les formes pour me tester</button></h2>
    <p class="sous">Clique sur une ligne pour l'écouter. En mode caché, clique sur une case floue pour vérifier ta réponse.</p>
    <table class="tableau-verbes" id="tableau">
      <thead><tr><th></th><th>Base</th><th>Prétérit</th><th>Participe passé</th><th>Français</th></tr></thead>
      <tbody>${VERBES.map(v => `<tr data-verbe="${v.id}"><td><span class="point ${pastille(v.id)}"></span></td><td><b>${esc(v.base)}</b></td>
        <td class="f">${esc(v.pret)}</td><td class="f">${esc(v.part)}</td><td class="fr">${esc(v.fr)}</td></tr>`).join("")}</tbody>
    </table>`);
  $("#chrono").onclick = defiChrono;
  $$("[data-vpack]").forEach(t => t.onclick = () => lancerPackVerbes(+t.dataset.vpack));
  $("#cacher").onclick = () => {
    const t = $("#tableau"), cache = t.classList.toggle("cache");
    $$(".f.vu", t).forEach(c => c.classList.remove("vu"));
    $("#cacher").textContent = cache ? "👁 Tout afficher" : "🙈 Cacher les formes pour me tester";
  };
  $$("[data-verbe]").forEach(tr => tr.onclick = e => {
    if (e.target.classList.contains("f")) e.target.classList.add("vu");
    direVerbe(IBYID[tr.dataset.verbe]);
  });
}

let minuteurChrono = null;
function defiChrono() {
  let pool = VERBES.filter(v => PROG.items[v.id]?.n);
  if (pool.length < 10) pool = VERBES.slice(0, 20);
  const DUREE = 60000, fin = Date.now() + DUREE;
  let score = 0, essais = 0, serie = 0, courant = null, champ = "pret", bloque = false;
  const erreurs = [];
  gestionTouches = null;
  clearInterval(minuteurChrono);
  couperVoix();
  $("#app").innerHTML = `<div class="ex">
    <div class="ex-top"><button class="icon-btn" id="quitter" title="Quitter (Échap)">✕</button>
      <div class="barre chrono-barre"><div id="temps" style="width:100%"></div></div>
      <span class="score-chrono">⭐ <b id="score">0</b></span></div>
    <div class="ex-main screen" style="text-align:center">
      <div class="consigne" id="demande">Prétérit ?</div>
      <div class="carte-question" style="justify-content:center"><div class="q" id="verbe" style="font-size:40px"></div></div>
      <input class="saisie" id="saisie" autocomplete="off" spellcheck="false" placeholder="Écris puis Entrée" style="text-align:center">
      <div class="flash" id="flash"></div>
      <p class="sous" id="serie" style="margin-top:8px"></p>
    </div></div>`;
  const champ$ = $("#saisie");
  const nouveau = () => {
    let v; do v = pick(pool); while (pool.length > 1 && v === courant);
    courant = v; champ = Math.random() < 0.6 ? "pret" : "part";
    $("#demande").textContent = champ === "pret" ? "Prétérit ?" : "Participe passé ?";
    $("#demande").style.color = champ === "pret" ? "var(--bleu)" : "var(--or)";
    $("#verbe").innerHTML = `${esc(v.base)} <small style="font-size:18px;color:var(--doux)">(${esc(v.fr)})</small>`;
    champ$.value = ""; champ$.disabled = false; champ$.className = "saisie"; champ$.focus();
    bloque = false;
  };
  const valider = () => {
    if (bloque || !champ$.value.trim()) return;
    const bonne = courant[champ], ok = corriger(champ$.value, [bonne, ...formes(bonne)], true).juste;
    essais++;
    majMemoire(courant.id, ok, true);
    if (ok) {
      score++; serie++; son("bon");
      $("#score").textContent = score;
      $("#flash").innerHTML = `<span style="color:var(--vert)">✓ ${esc(troisFormes(courant))}</span>`;
      $("#serie").textContent = serie >= 3 ? `🔥 ${serie} d'affilée !` : "";
      nouveau();
    } else {
      serie = 0; son("faux"); bloque = true;
      erreurs.push(courant);
      champ$.classList.add("faux"); champ$.disabled = true;
      $("#flash").innerHTML = `<span style="color:var(--rouge)">✗ ${esc(troisFormes(courant))}</span>`;
      $("#serie").textContent = "";
      setTimeout(() => { if (Date.now() < fin) nouveau(); }, 1300);   // petite pénalité de temps
    }
  };
  const terminer = () => {
    clearInterval(minuteurChrono);
    gestionTouches = null;
    const record = score > (PROG.recordChrono || 0);
    if (record) PROG.recordChrono = score;
    const xp = score * 3 + (record && score ? 20 : 0);
    if (xp) gagnerXP(xp);
    noterSuivi();
    celebrerNouveauxPaliers();
    const badges = verifierBadges();
    sauver();
    son(record && score ? "victoire" : "clic");
    if (record && score) setTimeout(confettis, 150);
    badges.forEach((b, k) => setTimeout(() => { son("badge"); toast(b.ic, `Badge débloqué : ${b.nom}`, b.desc); }, 900 + k * 700));
    const uniques = [...new Set(erreurs)];
    $("#app").innerHTML = `<div class="contenu" style="display:flex"><div class="fin screen">
      <div class="mascotte">${record && score ? "🏆" : "⏱️"}</div>
      <h1>${record && score ? "Nouveau record !" : "Temps écoulé !"}</h1>
      <div class="resume">
        <div class="stat or"><strong>${score}</strong><span>Points</span></div>
        <div class="stat vert"><strong>${essais ? Math.round(100 * score / essais) : 0} %</strong><span>Précision</span></div>
        <div class="stat bleu"><strong>${PROG.recordChrono || 0}</strong><span>Record</span></div>
      </div>
      <p class="sous">+${xp} XP</p>
      ${uniques.length ? `<div class="a-revoir"><h3>À revoir</h3>${uniques.map(v => `<button class="exemple" data-dire-verbe="${v.id}"><span class="hp-mini">🔊</span><div style="text-align:left"><div class="en">${esc(troisFormes(v))}</div><div class="fr">${esc(v.fr)}</div></div></button>`).join("")}</div>` : ""}
      <div class="actions"><button class="btn gris grand" id="retour">Verbes</button><button class="btn vert grand" id="rejouer">Rejouer</button></div>
    </div></div>`;
    $$("[data-dire-verbe]").forEach(b => b.onclick = () => direVerbe(IBYID[b.dataset.direVerbe]));
    $("#retour").onclick = verbes;
    $("#rejouer").onclick = defiChrono;
    gestionTouches = e => { if (e.key === "Enter") defiChrono(); else if (e.key === "Escape") verbes(); };
  };
  $("#quitter").onclick = () => { clearInterval(minuteurChrono); sauver(); verbes(); };
  gestionTouches = e => {
    if (e.key === "Enter") valider();
    else if (e.key === "Escape") { clearInterval(minuteurChrono); sauver(); verbes(); }
  };
  minuteurChrono = setInterval(() => {
    const reste = Math.max(0, fin - Date.now());
    const barre = $("#temps");
    if (!barre) return clearInterval(minuteurChrono);
    barre.style.width = `${100 * reste / DUREE}%`;
    barre.style.background = reste < 10000 ? "linear-gradient(90deg, var(--rouge), var(--orange))" : "";
    if (!reste) terminer();
  }, 100);
  nouveau();
}

// ------------------------------------------------------------------ progrès
function progres() {
  const s = PROG.stats, tot = s.bonnes + s.mauvaises, faibles = pointsFaibles();
  const enMemoire = Object.keys(PROG.items).filter(id => proba(id) >= 0.8).length;
  const jours = Array.from({ length: 14 }, (_, k) => dateStr(Date.now() - (13 - k) * JOUR));
  const max = Math.max(PROG.objectif, ...jours.map(j => PROG.jours[j] || 0));
  afficher(`<h1>Tes progrès</h1><p class="sous">Rang actuel : ${rang()[2]} <b>${rang()[1]}</b>${RANGS.find(r => r[0] > PROG.xp) ? ` · prochain rang à ${RANGS.find(r => r[0] > PROG.xp)[0]} XP` : ""}</p>
    <div class="grille-stats">
      <div class="stat"><strong style="color:var(--or)">${PROG.xp}</strong><span>XP au total</span></div>
      <div class="stat"><strong style="color:var(--orange)">${serieActuelle()} j</strong><span>Série actuelle (record ${PROG.meilleureSerie} j)</span></div>
      <div class="stat"><strong style="color:var(--vert)">${tot ? Math.round(100 * s.bonnes / tot) : 0} %</strong><span>Réponses justes (${tot})</span></div>
      <div class="stat"><strong style="color:var(--bleu)">${enMemoire}</strong><span>Éléments bien en mémoire</span></div>
    </div>
    <h2>XP des 14 derniers jours</h2>
    <div class="graphe">${jours.map(j => { const v = PROG.jours[j] || 0; return `<div class="col" title="${v} XP"><div class="b ${v >= PROG.objectif ? "ok" : ""}" style="height:${100 * v / max}%"></div><small>${j.slice(8)}</small></div>`; }).join("")}</div>
    <h2>Objectif quotidien</h2>
    <div class="choix-objectif">${[[20, "Tranquille"], [50, "Normal"], [100, "Sérieux"], [150, "Intense"]].map(([v, n]) => `<button data-obj="${v}" class="${PROG.objectif === v ? "on" : ""}">${n} · ${v} XP</button>`).join("")}</div>
    <h2>🎯 Tes points faibles</h2>
    ${faibles.length ? `<div class="liste-faibles">${faibles.slice(0, 8).map(id => `<div class="faible"><span>${esc(decrire(id))}</span><small>raté ${PROG.items[id].ko} fois</small></div>`).join("")}</div>
      <button class="btn" id="faibles" style="margin-top:12px">🎯 M'entraîner sur mes points faibles</button>`
      : `<p class="sous">Aucun point faible pour l'instant 💪 Ceux que tu rates au moins 2 fois apparaîtront ici.</p>`}
    <h2>Badges</h2>
    <div class="grille-badges">${BADGES.map(b => `<div class="badge ${PROG.badges.includes(b.id) ? "" : "non"}"><span class="ic">${b.ic}</span><h4>${esc(b.nom)}</h4><p>${esc(b.desc)}</p></div>`).join("")}</div>
    <h2 id="sync">☁️ Synchronisation PC ↔ iPhone</h2>
    <div class="reglages">${blocSync()}</div>
    <h2>⚙️ Réglages</h2>
    <div class="reglages">
      <div class="reglage" ${API ? "" : 'style="display:none"'}><div><b>⏰ Rappel quotidien</b><small>Une petite fenêtre te rappelle ta session à l'heure choisie, seulement si tu n'as pas encore atteint ton objectif.</small></div>
        <div class="ligne-reglage"><input type="time" id="heure" value="${PROG.rappel || "19:00"}">
          <button class="btn ${PROG.rappel ? "gris" : "vert"}" id="rappel-on">${PROG.rappel ? "Modifier" : "Activer"}</button>
          ${PROG.rappel ? `<button class="btn gris" id="rappel-off">Désactiver</button>` : ""}</div>
        <small id="rappel-etat">${PROG.rappel ? `✅ Actif tous les jours à ${PROG.rappel}` : "Désactivé"}</small></div>
      <div class="reglage"><div><b>🗣️ Voix naturelle</b><small>Une vraie voix anglaise de Microsoft (nécessite Internet ; les phrases déjà entendues restent disponibles hors ligne). Sinon, la voix Windows.</small></div>
        <button class="btn ${PROG.voixNaturelle !== false ? "vert" : "gris"}" id="voix">${PROG.voixNaturelle !== false ? "Activée" : "Désactivée"}</button></div>
      <div class="reglage"><div><b>❄️ Gels de série : ${PROG.gels || 0} / 2</b><small>Un gel protège ta série quand tu manques un jour. Tu en gagnes un tous les 7 jours d'objectif atteint (${(PROG.joursObjectif || 0) % 7} / 7).</small></div></div>
    </div>`);
  $$("[data-obj]").forEach(b => b.onclick = () => { PROG.objectif = +b.dataset.obj; sauver(); progres(); });
  if ($("#faibles")) $("#faibles").onclick = lancerFaibles;
  brancherSync();
  $("#voix").onclick = () => { PROG.voixNaturelle = PROG.voixNaturelle === false; sauver(); progres(); parler("Hello! This is my voice."); };
  const regler = async heure => {
    if (!API) { $("#rappel-etat").textContent = "Disponible uniquement dans l'appli (pas dans l'aperçu)."; return; }
    const r = await API.rappel(heure);
    if (r.ok) { PROG.rappel = heure; sauver(); progres(); toast("⏰", heure ? `Rappel programmé à ${heure}` : "Rappel désactivé", heure ? "Tous les jours, si ton objectif n'est pas atteint." : ""); }
    else $("#rappel-etat").textContent = "Impossible de programmer le rappel : " + r.message;
  };
  $("#rappel-on").onclick = () => regler($("#heure").value || "19:00");
  if ($("#rappel-off")) $("#rappel-off").onclick = () => regler(null);
}
function blocSync() {
  if (!cloudConfigure()) return `<div class="reglage"><div><b>Pas encore configurée</b><small>La synchronisation sera disponible une fois le compte Supabase relié à l'appli.</small></div></div>`;
  if (COMPTE) {
    const quand = etatSync.derniere ? new Date(etatSync.derniere).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "—";
    return `<div class="reglage"><div><b>✅ Connecté : ${esc(COMPTE.email || "")}</b>
        <small>Ta progression est enregistrée en ligne et partagée entre tous tes appareils. Dernière synchronisation : ${quand}${etatSync.statut === "erreur" ? ` · ⚠️ ${esc(etatSync.message)}` : ""}</small>
        <small>👨‍👩‍👦 Appareil partagé ? Déconnecte-toi avant qu'une autre personne se connecte : ta progression reste en sécurité en ligne.</small></div>
      <div class="ligne-reglage"><button class="btn vert" id="sync-maint">🔄 Synchroniser</button><button class="btn gris" id="sync-deco">Se déconnecter</button></div></div>`;
  }
  return `<div class="reglage formulaire-sync"><div><b>Connecte-toi pour retrouver ta progression partout</b>
      <small>Utilise le même e-mail et le même mot de passe sur ton PC et sur ton iPhone. La première fois, clique sur « Créer mon compte » ; ensuite, sur « Se connecter ».</small></div>
    <div class="champs-sync">
      <input type="email" id="sync-email" placeholder="Adresse e-mail" autocomplete="email">
      <input type="password" id="sync-mdp" placeholder="Mot de passe (6 caractères minimum)" autocomplete="current-password">
      <div class="ligne-reglage"><button class="btn vert" id="sync-connexion">Se connecter</button><button class="btn gris" id="sync-creer">Créer mon compte</button></div>
      <small id="sync-msg"></small></div></div>`;
}
function brancherSync() {
  if ($("#sync-maint")) $("#sync-maint").onclick = async () => { $("#sync-maint").textContent = "⏳…"; await synchroniser(); progres(); toast("☁️", etatSync.statut === "ok" ? "Synchronisé !" : "Échec de la synchronisation", etatSync.message || ""); };
  if ($("#sync-deco")) $("#sync-deco").onclick = async () => {
    if (!confirm("Se déconnecter ?\n\nTa progression est enregistrée en ligne, puis retirée de cet appareil. Tu la retrouveras en te reconnectant.")) return;
    $("#sync-deco").textContent = "⏳…";
    if (await deconnexion()) { toast("👋", "Déconnecté", "Ta progression est en sécurité en ligne."); accueil(); }
    else { toast("⚠️", "Déconnexion annulée", "Synchronisation impossible (pas d'Internet ?) : rien n'a été effacé."); progres(); }
  };
  const agir = async creer => {
    const email = $("#sync-email").value.trim(), mdp = $("#sync-mdp").value, msg = $("#sync-msg");
    if (!email || !mdp) { msg.textContent = "Indique ton e-mail et ton mot de passe."; return; }
    msg.textContent = "⏳ Connexion…";
    try {
      const r = await connexion(email, mdp, creer);
      if (r.confirmer) { msg.textContent = "📧 Compte créé ! Clique sur le lien reçu par e-mail, puis reviens ici et clique sur « Se connecter »."; return; }
      toast("☁️", "Connecté !", "Ta progression est maintenant synchronisée.");
      progres();
      setTimeout(() => $("#sync")?.scrollIntoView(), 50);
    } catch (e) { msg.textContent = "⚠️ " + traduireErreur(e.message); }
  };
  if ($("#sync-connexion")) $("#sync-connexion").onclick = () => agir(false);
  if ($("#sync-creer")) $("#sync-creer").onclick = () => agir(true);
}
function decrire(id) {
  if (id[0] === "p") { const [, i, j] = id.split("-").map(Number), p = LECONS[i].phrases[j]; return `${p[1]} → ${p[2]}`; }
  if (id[0] === "v") return `${VBYID[id].en} = ${VBYID[id].fr}`;
  if (id[0] === "i") return `${troisFormes(IBYID[id])} (${IBYID[id].fr})`;
  if (id[0] === "c") { const L = ligneCine(id); return `${L.en} → ${L.fr}`; }
  return id;
}

// ------------------------------------------------------------------ science
function science() {
  afficher(`<h1>Pourquoi ça marche ?</h1><p class="sous">L'appli applique ce que la recherche sur l'apprentissage des langues et la mémoire a le mieux démontré. Le détail et les sources sont dans le fichier ETUDES.md.</p>
    <div class="science">${SCIENCE.map(s => `<div class="carte-s"><span class="ic">${s.ic}</span><h3>${esc(s.titre)}</h3>
      <span class="chiffre">${esc(s.chiffre)}</span><p>${esc(s.p)}</p><p style="margin-top:8px"><i>${esc(s.etude)}</i></p>
      <p class="appli">✅ ${esc(s.appli)}</p></div>`).join("")}</div>`);
}

// ------------------------------------------------------------------ construction des exercices
const sansPonct = s => s.replace(/[.,!?;:"«»()…]/g, "").replace(/\s+/g, " ").trim();
function distracteurs(v) {
  const res = [];
  for (const w of [...shuffle(VOCAB.filter(w => w.pi === v.pi && w.id !== v.id)).slice(0, 2), ...shuffle(VOCAB.filter(w => w.pi !== v.pi))]) {
    if (res.length === 3) break;
    if (w.fr !== v.fr && w.en !== v.en && !res.some(r => r.fr === w.fr)) res.push(w);
  }
  return res;
}
function exercice(id, mode) {
  const s = PROG.items[id]?.s || 0;
  if (id[0] === "p") {
    const [, i, j] = id.split("-").map(Number);
    const [sens, q, bonne, pieges, astuce] = LECONS[i].phrases[j];
    if (!mode && (sens === "fr-en" ? s >= 4 && Math.random() < 0.25 : s >= 3 && Math.random() < 0.5)) mode = "dictee";
    if (mode === "dictee") {   // écouter la phrase anglaise et l'écrire
      const en = sens === "fr-en" ? bonne : q, fr = sens === "fr-en" ? q : bonne;
      return { id, mode, question: en, bonne: en, acceptes: [en], astuce: `Traduction : ${fr}`, audioQuestion: en, production: true,
        consigne: "Dictée : écoute et écris la phrase en anglais" };
    }
    if (sens === "fr-en") {
      mode = mode || (s <= 1 ? "qcm" : s === 2 ? "tiles" : Math.random() < 0.7 ? "type" : "tiles");
      const ex = { id, mode, question: q, bonne, astuce, audioReponse: bonne, acceptes: [bonne], production: mode !== "qcm",
        consigne: { qcm: "Choisis la bonne traduction", tiles: "Construis la phrase en anglais", type: "Écris la phrase en anglais" }[mode] };
      if (mode === "qcm") ex.choix = shuffle([bonne, ...pieges]);
      if (mode === "tiles") {
        const mots = sansPonct(bonne).split(" "), deja = new Set(mots.map(w => w.toLowerCase())), extra = [];
        pieges.forEach(p => sansPonct(p).split(" ").forEach(w => { const k = w.toLowerCase(); if (!deja.has(k)) { deja.add(k); extra.push(w); } }));
        ex.tuiles = shuffle([...mots, ...shuffle(extra).slice(0, 3)]);
      }
      return ex;
    }
    mode = mode || (s <= 1 ? "qcm" : "listen");
    return { id, mode, question: q, bonne, astuce, audioQuestion: q, choix: shuffle([bonne, ...pieges]), production: false,
      consigne: mode === "listen" ? "Écoute et choisis la traduction" : "Choisis la bonne traduction" };
  }
  if (id[0] === "i") return exerciceVerbe(id, mode);
  if (id[0] === "c") return exerciceCine(id, mode);
  const v = VBYID[id], autres = distracteurs(v);
  mode = mode || ["qcm", "qcm-inv", "listen"][s] || "type";
  const astuce = `${v.en} = ${v.fr}`;
  if (mode === "qcm" || mode === "listen")
    return { id, mode, question: v.en, bonne: v.fr, astuce, audioQuestion: v.en, choix: shuffle([v.fr, ...autres.map(a => a.fr)]), production: false,
      consigne: mode === "listen" ? "Écoute : que veut dire ce mot ?" : "Que veut dire ce mot ?" };
  if (mode === "qcm-inv")
    return { id, mode: "qcm", question: v.fr, bonne: v.en, astuce, audioReponse: v.en, choix: shuffle([v.en, ...autres.map(a => a.en)]), production: false,
      consigne: "Comment dit-on en anglais ?" };
  return { id, mode: "type", question: v.fr, bonne: v.en, astuce, audioReponse: v.en, production: true,
    acceptes: VOCAB.filter(w => w.fr === v.fr).map(w => w.en), consigne: "Écris le mot en anglais" };
}

// Verbes irréguliers : prétérit en QCM → participe en QCM → prétérit à écrire → les deux formes à écrire.
const regulariser = b => b.endsWith("e") ? b + "d" : /[^aeiou]y$/.test(b) ? b.slice(0, -1) + "ied" : b + "ed";
function piegesVerbe(v, champ) {   // erreurs typiques : forme régulière inventée, l'autre forme, la base, un autre verbe
  const bonne = v[champ], interdit = new Set([bonne, ...formes(bonne)]), res = [];
  const autres = shuffle(VERBES.filter(w => w.id !== v.id)).map(w => w[champ]);
  for (const c of [regulariser(v.base), champ === "pret" ? v.part : v.pret, v.base, v.base + "s", ...autres]) {
    if (res.length === 3) break;
    if (!interdit.has(c) && !res.includes(c) && !formes(c).some(f => interdit.has(f))) res.push(c);
  }
  return res;
}
function exerciceVerbe(id, mode) {
  const v = IBYID[id], s = PROG.items[id]?.s || 0;
  mode = mode || ["qcm-pret", "qcm-part", "type-pret"][s] || "type2";
  const note = v.pret === v.part ? (v.base === v.pret ? " · les 3 formes sont identiques !" : " · prétérit et participe sont identiques") : "";
  const commun = { id, modeCle: mode, verbe: v, question: `${v.base}  (${v.fr})`, audioQuestion: v.base, astuce: `**${troisFormes(v)}** = ${v.fr}${note}` };
  if (mode === "qcm-pret" || mode === "qcm-part") {
    const champ = mode === "qcm-pret" ? "pret" : "part";
    return { ...commun, mode: "qcm", bonne: v[champ], choix: shuffle([v[champ], ...piegesVerbe(v, champ)]), production: false,
      consigne: champ === "pret" ? "Quel est le prétérit (passé simple) ?" : "Quel est le participe passé ?" };
  }
  if (mode === "type-pret")
    return { ...commun, mode: "type", bonne: v.pret, acceptes: [v.pret, ...formes(v.pret)], strict: true, production: true,
      consigne: "Écris le prétérit (passé simple)", placeholder: "Prétérit…" };
  return { ...commun, mode: "type2", bonne: `${v.pret} – ${v.part}`, production: true, consigne: "Écris le prétérit et le participe passé" };
}

// Ciné-club : traduire la réplique → la compléter (QCM) → écrire le mot manquant → dictée de toute la réplique.
function exerciceCine(id, mode) {
  const L = ligneCine(id), s = PROG.items[id]?.s || 0;
  mode = mode || ["trad", "trou-qcm", "trou"][s] || (Math.random() < 0.5 ? "trou" : "dictee");
  const avecTrou = L.en.replace(new RegExp(`\\b${L.trou}\\b`), "_____");
  const commun = { id, modeCle: mode, perso: L.perso, voix: L.voix, audioQuestion: L.en, repTexte: `${L.en}  (${L.fr})`,
    astuce: `**${L.en}** = ${L.fr}`, titreScene: `${L.scene.icone} ${L.scene.titre}` };
  if (mode === "trad")
    return { ...commun, mode: "qcm", question: L.en, bonne: L.fr, choix: shuffle([L.fr, ...L.piegesFr]), production: false, repTexte: null,
      consigne: "🎬 Traduis la réplique en français" };
  if (mode === "trou-qcm")
    return { ...commun, mode: "qcm", question: avecTrou, bonne: L.trou, choix: shuffle([L.trou, ...L.piegesTrou]), production: false,
      consigne: "🎬 Écoute et complète la réplique" };
  if (mode === "trou")
    return { ...commun, mode: "type", question: avecTrou, bonne: L.trou, acceptes: [L.trou], production: true, placeholder: "Le mot manquant…",
      consigne: "🎬 Écoute et écris le mot manquant" };
  return { ...commun, mode: "dictee", question: L.en, bonne: L.en, acceptes: [L.en], production: true, astuce: `Traduction : ${L.fr}`,
    consigne: "🎬 Dictée : écris toute la réplique" };
}

// ------------------------------------------------------------------ correction des réponses écrites
const CONTRACTIONS = {
  "i'm": "i am", "you're": "you are", "he's": "he is", "she's": "she is", "it's": "it is", "we're": "we are", "they're": "they are",
  "isn't": "is not", "aren't": "are not", "wasn't": "was not", "weren't": "were not", "don't": "do not", "doesn't": "does not",
  "didn't": "did not", "can't": "cannot", "won't": "will not", "i'll": "i will", "you'll": "you will", "he'll": "he will",
  "she'll": "she will", "it'll": "it will", "we'll": "we will", "they'll": "they will", "i've": "i have", "you've": "you have",
  "we've": "we have", "they've": "they have", "what's": "what is", "where's": "where is", "there's": "there is", "that's": "that is",
  "let's": "let us", "haven't": "have not", "hasn't": "has not", "shouldn't": "should not", "couldn't": "could not", "wouldn't": "would not",
};
const US_UK = [["favorite", "favourite"], ["color", "colour"], ["center", "centre"], ["theater", "theatre"], ["ok", "okay"], ["mom", "mum"]];
function normaliser(s) {
  s = s.toLowerCase().replace(/[’‘`]/g, "'").replace(/[.,!?;:"«»()…—–]/g, " ");
  s = s.replace(/[a-z]+'[a-z]+/g, m => CONTRACTIONS[m] || m).replace(/'/g, "").replace(/\bcan not\b/g, "cannot");
  for (const [us, uk] of US_UK) s = s.replace(new RegExp(`\\b${us}\\b`, "g"), uk);
  return s.replace(/\s+/g, " ").trim();
}
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);   // lettres inversées
  }
  return d[a.length][b.length];
}
// Tolère UNE faute de frappe sur un mot long, mais jamais un -s / -d oublié (c'est de la grammaire).
function fauteDeFrappe(n, na) {
  const a = n.split(" "), b = na.split(" ");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let k = 0; k < a.length; k++) {
    if (a[k] === b[k]) continue;
    const [lo, hi] = a[k].length < b[k].length ? [a[k], b[k]] : [b[k], a[k]];
    if (b[k].length < 5 || lev(a[k], b[k]) > 1 || hi === lo + "s" || hi === lo + "d") return false;
    if (++diff > 1) return false;
  }
  return diff === 1;
}
function corriger(saisie, acceptes, strict = false) {   // strict : l'orthographe exacte compte (verbes à apprendre par cœur)
  const n = normaliser(saisie);
  for (const a of acceptes) if (n === normaliser(a)) return { juste: true };
  if (!strict) for (const a of acceptes) if (fauteDeFrappe(n, normaliser(a))) return { juste: true, presque: a };
  return { juste: false };
}

// ------------------------------------------------------------------ lancement des sessions
function lancerLecon(i, k) {
  if (k === undefined) k = etoilesPartie(i, 0) && !etoilesPartie(i, 1) ? 1 : 0;
  const L = LECONS[i], ids = PARTIES[k].map(j => `p-${i}-${j}`);
  const enAnglais = shuffle(ids.filter(id => L.phrases[+id.split("-")[2]][0] === "fr-en")).slice(0, 2);
  const file = [{ regle: true, i, k }, ...shuffle(ids).map(id => ({ id })), ...enAnglais.map(id => ({ id, mode: "tiles" }))];
  demarrer("lecon", file, { i, k, titre: `Leçon ${i + 1} · partie ${k + 1}` });
}
function sequenceNouveaux(ids, modeA = "qcm", modeB = "qcm-inv", cle = "intro") {   // découverte entrecoupée de rappels, puis 2e rappel
  const file = [];
  ids.forEach((id, k) => { file.push({ id, [cle]: true }); if (k > 0) file.push({ id: ids[k - 1], mode: modeA }); });
  if (ids.length) file.push({ id: ids[ids.length - 1], mode: modeA });
  if (modeB !== null) shuffle(ids).forEach(id => file.push({ id, mode: modeB }));
  return file;
}
function lancerFaibles() {   // fiche explicative d'abord, puis rappel un peu plus tard
  const ids = pointsFaibles().slice(0, 8);
  if (!ids.length) return accueil();
  demarrer("faibles", sequenceNouveaux(ids, undefined, null, "fiche").map(e => e.fiche ? e : { id: e.id }), { titre: "Points faibles" });
}
function lancerScene(s) {   // 1re fois : traduction de chaque réplique + 3 phrases à trous ; ensuite selon la mémoire
  const ids = idsScene(s), dejaVue = PROG.scenes[s];
  const exos = dejaVue ? shuffle(ids).map(id => ({ id }))
    : [...shuffle(ids).map(id => ({ id, mode: "trad" })), ...shuffle(ids).slice(0, 3).map(id => ({ id, mode: "trou-qcm" }))];
  demarrer("cine", [{ scene: s }, ...exos], { titre: CINE[s].titre });
}
function lancerHistoire(s) {
  demarrer("histoire", [{ histoire: s }, ...HISTOIRES[s].questions.map((_, q) => ({ question: [s, q] }))], { titre: HISTOIRES[s].titre });
}
function lancerPackVerbes(pi) {
  const p = VPACKS[pi], nouveaux = p.ids.filter(id => !PROG.items[id]?.n).slice(0, 5);
  const file = nouveaux.length ? sequenceNouveaux(nouveaux, "qcm-pret", "qcm-part")
    : [...p.ids].sort((a, b) => proba(a) - proba(b)).map(id => ({ id }));
  demarrer("verbes", file, { pi, titre: `${p.icone} ${p.pack}` });
}
function lancerPack(pi) {
  const p = PACKS[pi], nouveaux = p.ids.filter(id => !PROG.items[id]?.n).slice(0, 8);
  const file = nouveaux.length ? sequenceNouveaux(nouveaux)
    : [...p.ids].sort((a, b) => proba(a) - proba(b)).slice(0, 10).map(id => ({ id }));
  demarrer("pack", file, { pi, titre: `${p.icone} ${p.pack}` });
}
function lancerRevision(libre = false) {
  let ids = aReviser().slice(0, 12);
  if (libre === true && ids.length < 8)
    ids = [...ids, ...shuffle(Object.keys(PROG.items).filter(id => !ids.includes(id))).slice(0, 10 - ids.length)];
  const file = shuffle(ids).map(id => ({ id }));   // entremêlé : tous niveaux et vocabulaire mélangés
  if (!file.length) return accueil();
  demarrer("revision", file, { titre: "Révisions" });
}
function demarrer(type, file, opts) {
  SESSION = { type, file, ...opts, total: file.filter(estExercice).length, faits: 0,
    vies: type === "lecon" ? 3 : null, erreurs: 0, erreursPartie: 0, scores: {}, combo: 0, meilleurCombo: 0, xp: 0, bonnes: 0, debut: Date.now(),
    scenesVues: file.filter(e => "scene" in e).map(e => e.scene) };
  // prépare les sons de la session en arrière-plan pour qu'ils soient instantanés
  if (API && PROG.voixNaturelle !== false) {
    const textes = [];
    file.forEach(e => {
      if (e.regle) textes.push(...LECONS[e.i].regle.exemples.map(x => x[0]));
      else if ("histoire" in e) textes.push(HISTOIRES[e.histoire].phrases.map(p => p[0]).join(" "), ...HISTOIRES[e.histoire].phrases.map(p => p[0]));
      else if ("scene" in e) idsScene(e.scene).forEach(id => textes.push([texteAnglais(id), voixDe(id)]));
      else if (e.id) textes.push(voixDe(e.id) ? [texteAnglais(e.id), voixDe(e.id)] : texteAnglais(e.id));
    });
    const vus = new Set();
    API.prechauffer(textes.filter(t => { const k = JSON.stringify(t); return t && !vus.has(k) && vus.add(k); }));
  }
  suivant();
}
function suivant() {
  couperVoix();
  if (SESSION.vies !== null && SESSION.vies <= 0) return finSession(false);
  const e = SESSION.file.shift();
  if (!e) return finSession(true);
  if (e.regle) ecranRegle(e.i, e.k);
  else if (e.intro) ecranIntro(e.id);
  else if (e.fiche) ecranFiche(e.id);
  else if ("histoire" in e) ecranHistoire(e.histoire);
  else if ("scene" in e) ecranScene(e.scene);
  else if (e.question) ecranExercice(exerciceQuestion(...e.question));
  else ecranExercice(exercice(e.id, e.mode));
}
function exerciceQuestion(s, q) {
  const [question, bonne, pieges] = HISTOIRES[s].questions[q];
  return { id: `h-${s}-${q}`, mode: "qcm", question, bonne, choix: shuffle([bonne, ...pieges]), production: false,
    nonMemo: true, pasDeRelance: true, histoire: s, consigne: `📖 ${HISTOIRES[s].titre} · question ${q + 1}/${HISTOIRES[s].questions.length}` };
}

// ------------------------------------------------------------------ écrans de session
function cadreSession(main, pied = "") {
  const S = SESSION;
  gestionTouches = null;
  $("#app").innerHTML = `<div class="ex">
    <div class="ex-top">
      <button class="icon-btn" id="quitter" title="Quitter (Échap)">✕</button>
      <div class="barre"><div style="width:${100 * S.faits / Math.max(1, S.total)}%"></div></div>
      ${S.combo >= 3 ? `<span class="combo">🔥 ${S.combo} d'affilée</span>` : ""}
      ${S.vies !== null ? `<span class="coeurs">${"❤️".repeat(S.vies)}${"🖤".repeat(3 - S.vies)}</span>` : ""}
    </div>
    <div class="ex-main screen">${main}</div>
    <div class="ex-foot"><div class="int">${pied}</div></div>
  </div>`;
  $("#quitter").onclick = () => { sauver(); accueil(); };
}
function ecranRegle(i, k = 0) {
  const L = LECONS[i];
  cadreSession(`<div class="carte-centrale">
      <span class="etiquette">💡 ${k ? "Rappel de la leçon" : "Mini-leçon"} · Leçon ${i + 1} · partie ${k + 1}/2</span>
      <h1>${esc(L.titre)}</h1>
      <div class="regle-texte">${md(L.regle.texte)}</div>
      <div class="exemples">${L.regle.exemples.map(([en, fr]) => `<div class="exemple"><button class="hp-mini" data-dire="${esc(en)}">🔊</button>
        <div><div class="en">${esc(en)}</div><div class="fr">${esc(fr)}</div></div></div>`).join("")}</div>
    </div>`, `<button class="btn vert grand" id="ok">C'est parti ! →</button>`);
  $$("[data-dire]").forEach(b => b.onclick = () => parler(b.dataset.dire));
  $("#ok").onclick = suivant;
  gestionTouches = e => { if (e.key === "Enter") suivant(); if (e.key === "Escape") accueil(); };
}
function ecranIntro(id) {
  if (id[0] === "i") return ecranIntroVerbe(IBYID[id]);
  const v = VBYID[id];
  cadreSession(`<div class="carte-centrale">
      <span class="etiquette">✨ Nouveau mot · ${esc(PACKS[v.pi].pack)}</span>
      <div class="mot-geant">${esc(v.en)}</div>
      <div class="traduction">${esc(v.fr)}</div>
      <div style="display:flex;gap:12px;justify-content:center">
        <button class="haut-parleur" id="hp">🔊</button><button class="haut-parleur" id="hp-lent" title="Lentement">🐢</button></div>
    </div>`, `<button class="btn grand" id="ok">Je retiens ! →</button>`);
  $("#hp").onclick = () => parler(v.en);
  $("#hp-lent").onclick = () => parler(v.en, true);
  setTimeout(() => parler(v.en), 250);
  $("#ok").onclick = suivant;
  gestionTouches = e => { if (e.key === "Enter") suivant(); if (e.key === "Escape") accueil(); };
}

function ecranFiche(id) {   // point faible : on revoit la bonne réponse et l'explication avant de se retester
  const s = PROG.items[id] || {};
  let contenu;
  if (id[0] === "p") {
    const [, i, j] = id.split("-").map(Number), [sens, q, bonne, , astuce] = LECONS[i].phrases[j];
    const en = sens === "fr-en" ? bonne : q, fr = sens === "fr-en" ? q : bonne;
    contenu = `<div class="mot-geant" style="font-size:34px">${esc(en)}</div><div class="traduction">${esc(fr)}</div>
      <div class="regle-texte" style="text-align:center">💡 ${md(astuce)}</div>`;
  } else if (id[0] === "v") {
    contenu = `<div class="mot-geant">${esc(VBYID[id].en)}</div><div class="traduction">${esc(VBYID[id].fr)}</div>`;
  } else if (id[0] === "c") {
    const L = ligneCine(id);
    contenu = `<div class="perso" style="justify-content:center">🎭 ${esc(L.perso)} <span>· ${esc(L.scene.icone)} ${esc(L.scene.titre)}</span></div>
      <div class="mot-geant" style="font-size:32px">${esc(L.en)}</div><div class="traduction">${esc(L.fr)}</div>`;
  } else {
    const v = IBYID[id];
    contenu = `<div class="traduction" style="margin-bottom:14px">${esc(v.fr)}</div><div class="trois-formes">
      <div><small>Base</small><strong>${esc(v.base)}</strong></div><div><small>Prétérit</small><strong>${esc(v.pret)}</strong></div>
      <div><small>Participe passé</small><strong>${esc(v.part)}</strong></div></div>`;
  }
  cadreSession(`<div class="carte-centrale">
      <span class="etiquette" style="background:rgba(255,92,122,.2);color:#ffb3c1">🎯 Point faible · raté ${s.ko || 0} fois</span>
      ${contenu}
      <p class="sous" style="margin-top:12px">Lis bien, écoute, puis on te reteste juste après.</p>
      <div style="display:flex;gap:12px;justify-content:center"><button class="haut-parleur" id="hp">🔊</button><button class="haut-parleur" id="hp-lent">🐢</button></div>
    </div>`, `<button class="btn grand" id="ok">Compris ! →</button>`);
  const texte = texteAnglais(id), voix = voixDe(id);
  $("#hp").onclick = () => parler(texte, false, voix);
  $("#hp-lent").onclick = () => parler(texte, true, voix);
  setTimeout(() => parler(texte, false, voix), 250);
  $("#ok").onclick = suivant;
  gestionTouches = e => { if (e.key === "Enter") suivant(); if (e.key === "Escape") accueil(); };
}

function ecranHistoire(s) {
  const h = HISTOIRES[s], toutLeTexte = h.phrases.map(p => p[0]).join(" ");
  cadreSession(`<div class="carte-centrale histoire">
      <span class="etiquette">📖 Histoire · niveau ${esc(h.niveau)}</span>
      <h1>${h.icone} ${esc(h.titre)}</h1>
      <div style="display:flex;gap:10px;justify-content:center;margin:10px 0 18px">
        <button class="btn" id="tout">▶ Écouter l'histoire</button><button class="btn gris" id="tout-lent">🐢 Lentement</button></div>
      <div class="texte-histoire">${h.phrases.map(([en, fr], k) => `<div class="ligne-histoire">
        <button class="hp-mini" data-k="${k}" title="Écouter">🔊</button>
        <div class="txt-h"><div class="en">${esc(en)}</div><div class="fr cache" id="fr-${k}">${esc(fr)}</div></div>
        <button class="hp-mini drapeau" data-fr="${k}" title="Voir la traduction">🇫🇷</button></div>`).join("")}</div>
      <p class="sous" style="margin-top:14px">Essaie de comprendre sans la traduction, puis vérifie avec 🇫🇷 si besoin.</p>
    </div>`, `<button class="btn vert grand" id="ok">Aux questions →</button>`);
  $("#tout").onclick = () => parler(toutLeTexte);
  $("#tout-lent").onclick = () => parler(toutLeTexte, true);
  $$("[data-k]").forEach(b => b.onclick = () => parler(h.phrases[+b.dataset.k][0]));
  $$("[data-fr]").forEach(b => b.onclick = () => $(`#fr-${b.dataset.fr}`).classList.toggle("cache"));
  $("#ok").onclick = suivant;
  gestionTouches = e => { if (e.key === "Enter") suivant(); if (e.key === "Escape") accueil(); };
}

// Lecteur de scène : chaque personnage a sa voix, sous-titres anglais (+ français à la demande)
function ecranScene(s) {
  const sc = CINE[s];
  let k = 0, enLecture = false, lent = false, stFr = false;
  cadreSession(`<div class="cinema" style="--couleur:${sc.couleur}">
      <div class="ecran-cine">
        <div class="affiche-cine"><span>${sc.icone}</span><small>${esc(sc.genre)}</small><h2>${esc(sc.titre)}</h2></div>
        <div class="sous-titres"><div class="st-perso" id="st-perso">🎬 Le contexte</div>
          <div class="st-en" id="st-en">${esc(sc.contexte)}</div><div class="st-fr" id="st-fr"></div></div>
      </div>
      <div class="controles-cine">
        <button class="btn vert" id="lecture">▶ Lecture</button>
        <button class="btn gris" id="prec" title="Réplique précédente">⏮</button>
        <button class="btn gris" id="suiv" title="Réplique suivante">⏭</button>
        <button class="btn gris" id="lent">🐢 Vitesse normale</button>
        <button class="btn gris" id="stfr">Sous-titres FR : non</button>
      </div>
      <div class="script-cine">${sc.lignes.map(([p, en], l) => `<button class="replique" data-l="${l}"><b>${esc(p)}</b><span>${esc(en)}</span></button>`).join("")}</div>
      <p class="sous" style="margin-top:12px">Regarde la scène autant de fois que tu veux, puis passe aux exercices : traduire et compléter les répliques.</p>
    </div>`, `<button class="btn grand" id="ok">Aux exercices →</button>`);
  const montrer = l => {
    const [perso, en, fr] = sc.lignes[l];
    $("#st-perso").textContent = `🎭 ${perso}`;
    $("#st-en").textContent = en;
    $("#st-fr").textContent = stFr ? fr : "";
    $$(".replique").forEach((b, i) => b.classList.toggle("active", i === l));
  };
  const jouer = async l => {
    k = l; montrer(l);
    const [perso, en] = sc.lignes[l];
    await parler(en, lent, sc.persos[perso]);
  };
  const lecture = async () => {
    if (enLecture) { enLecture = false; couperVoix(); $("#lecture").textContent = "▶ Lecture"; return; }
    enLecture = true; $("#lecture").textContent = "⏸ Pause";
    if (k >= sc.lignes.length) k = 0;
    while (enLecture && k < sc.lignes.length && $("#lecture")) {
      await jouer(k);
      if (!enLecture) break;
      await new Promise(r => setTimeout(r, 450));
      k++;
    }
    if ($("#lecture")) { enLecture = false; $("#lecture").textContent = k >= sc.lignes.length ? "↻ Revoir" : "▶ Lecture"; }
  };
  $("#lecture").onclick = lecture;
  $("#prec").onclick = () => { enLecture = false; $("#lecture").textContent = "▶ Lecture"; jouer(Math.max(0, k - 1)); };
  $("#suiv").onclick = () => { enLecture = false; $("#lecture").textContent = "▶ Lecture"; jouer(Math.min(sc.lignes.length - 1, k + 1)); };
  $("#lent").onclick = () => { lent = !lent; $("#lent").textContent = lent ? "🐢 Lentement" : "🐢 Vitesse normale"; };
  $("#stfr").onclick = () => { stFr = !stFr; $("#stfr").textContent = `Sous-titres FR : ${stFr ? "oui" : "non"}`; if ($(".replique.active")) montrer(k); };
  $$(".replique").forEach(b => b.onclick = () => { enLecture = false; $("#lecture").textContent = "▶ Lecture"; jouer(+b.dataset.l); });
  $("#ok").onclick = () => { enLecture = false; suivant(); };
  gestionTouches = e => {
    if (e.key === " ") { e.preventDefault(); lecture(); }
    else if (e.key === "Enter") { enLecture = false; suivant(); }
    else if (e.key === "Escape") { enLecture = false; accueil(); }
  };
}

function ecranIntroVerbe(v) {
  const note = v.pret === v.part ? (v.base === v.pret ? "Les 3 formes sont identiques : facile !" : "Prétérit et participe passé sont identiques.") : "";
  cadreSession(`<div class="carte-centrale">
      <span class="etiquette">🔁 Nouveau verbe · ${esc(VPACKS[v.pi].pack)}</span>
      <div class="traduction" style="margin-bottom:14px">${esc(v.fr)}</div>
      <div class="trois-formes">
        <div><small>Base</small><strong>${esc(v.base)}</strong></div>
        <div><small>Prétérit</small><strong>${esc(v.pret)}</strong></div>
        <div><small>Participe passé</small><strong>${esc(v.part)}</strong></div>
      </div>
      ${note ? `<p class="sous" style="margin-top:14px">💡 ${note}</p>` : ""}
      <p class="sous" style="margin-top:6px">Répète les 3 formes à voix haute, comme une petite chanson 🎵</p>
      <div style="display:flex;gap:12px;justify-content:center">
        <button class="haut-parleur" id="hp">🔊</button><button class="haut-parleur" id="hp-lent" title="Lentement">🐢</button></div>
    </div>`, `<button class="btn grand" id="ok">Je retiens ! →</button>`);
  $("#hp").onclick = () => direVerbe(v);
  $("#hp-lent").onclick = () => direVerbe(v, true);
  setTimeout(() => direVerbe(v), 250);
  $("#ok").onclick = suivant;
  gestionTouches = e => { if (e.key === "Enter") suivant(); if (e.key === "Escape") accueil(); };
}

function ecranExercice(ex) {
  SESSION.ex = ex; SESSION.repondu = false;
  let haut;
  if (ex.mode === "listen" || ex.mode === "dictee") {
    haut = `<div class="ecoute"><button class="haut-parleur gros-hp" id="hp">🔊</button>
      <div class="ligne"><button class="btn gris" id="hp-lent">🐢 Lentement</button>${ex.mode === "listen" ? `<button class="btn gris" id="voir">👁 Voir le texte</button>` : ""}</div>
      <div class="texte-cache" id="texte"></div></div>`;
  } else {
    haut = `<div class="carte-question">${ex.audioQuestion ? `<button class="haut-parleur" id="hp" title="Écouter">🔊</button>` : ""}
      <div>${ex.perso ? `<div class="perso">🎭 ${esc(ex.perso)} <span>· ${esc(ex.titreScene)}</span></div>` : ""}
      <div class="q">${esc(ex.question).replace("_____", '<span class="trou">_____</span>')}</div></div></div>`;
    if (ex.histoire !== undefined)
      haut += `<details class="revoir"><summary>📖 Revoir le texte</summary><p>${HISTOIRES[ex.histoire].phrases.map(p => esc(p[0])).join(" ")}</p></details>`;
  }
  let corps = "", pied = "";
  if (ex.choix) {
    corps = `<div class="reponses">${ex.choix.map((c, k) => `<button class="option" data-k="${k}"><kbd>${k + 1}</kbd><span>${esc(c)}</span></button>`).join("")}</div>`;
    pied = `<span style="color:var(--doux);align-self:center">Touches 1 à 4 pour répondre</span>`;
  } else if (ex.mode === "tiles") {
    corps = `<div class="zone-reponse" id="zone"></div><div class="banque">${ex.tuiles.map((t, k) => `<button class="tuile-mot" data-t="${k}">${esc(t)}</button>`).join("")}</div>`;
    pied = `<button class="btn gris" id="effacer">Effacer</button><button class="btn vert" id="verifier" disabled>Vérifier</button>`;
  } else if (ex.mode === "type2") {
    corps = `<div class="deux-champs">
      <label><small>Prétérit</small><input class="saisie" id="saisie1" placeholder="…" autocomplete="off" spellcheck="false"></label>
      <label><small>Participe passé</small><input class="saisie" id="saisie2" placeholder="…" autocomplete="off" spellcheck="false"></label></div>`;
    pied = `<button class="btn gris" id="passer">Je ne sais pas</button><button class="btn vert" id="verifier" disabled>Vérifier</button>`;
  } else {
    corps = `<input class="saisie" id="saisie" placeholder="${esc(ex.placeholder || (ex.mode === "dictee" ? "Écris ce que tu entends…" : "Écris en anglais…"))}" autocomplete="off" spellcheck="false">`;
    pied = `<button class="btn gris" id="passer">Je ne sais pas</button><button class="btn vert" id="verifier" disabled>Vérifier</button>`;
  }
  cadreSession(`<div class="consigne">${esc(ex.consigne)}</div>${haut}${corps}`, pied);

  if (ex.audioQuestion) {
    $("#hp").onclick = () => parler(ex.audioQuestion, false, ex.voix);
    setTimeout(() => parler(ex.audioQuestion, false, ex.voix), 200);
  }
  if (ex.mode === "listen" || ex.mode === "dictee") $("#hp-lent").onclick = () => parler(ex.audioQuestion, true, ex.voix);
  if (ex.mode === "listen") $("#voir").onclick = () => { $("#texte").textContent = ex.question; };

  if (ex.choix) {
    const choisir = k => {
      if (SESSION.repondu) return;
      const c = ex.choix[k], juste = c === ex.bonne;
      $(".reponses").classList.add("fige");
      $$(".option").forEach((o, kk) => {
        if (ex.choix[kk] === ex.bonne) o.classList.add("juste");
        else if (kk === k) o.classList.add("faux");
        else o.classList.add("eteinte");
      });
      repondre(juste);
    };
    $$(".option").forEach(o => o.onclick = () => choisir(+o.dataset.k));
    gestionTouches = e => {
      if (/^[1-4]$/.test(e.key)) choisir(+e.key - 1);
      else if (e.key === "Escape") accueil();
    };
  } else if (ex.mode === "tiles") {
    const zone = $("#zone"), place = [];
    const maj = () => { $("#verifier").disabled = !place.length; };
    $$(".tuile-mot[data-t]").forEach(b => b.onclick = () => {
      if (SESSION.repondu || b.classList.contains("vide")) return;
      son("clic");
      b.classList.add("vide");
      const k = +b.dataset.t, t = document.createElement("button");
      t.className = "tuile-mot"; t.textContent = ex.tuiles[k];
      place.push(k);
      t.onclick = () => { if (SESSION.repondu) return; place.splice(place.indexOf(k), 1); t.remove(); b.classList.remove("vide"); maj(); };
      zone.appendChild(t); maj();
    });
    const verifier = () => {
      if (SESSION.repondu || !place.length) return;
      repondre(normaliser(place.map(k => ex.tuiles[k]).join(" ")) === normaliser(ex.bonne));
    };
    $("#verifier").onclick = verifier;
    $("#effacer").onclick = () => { zone.innerHTML = ""; place.length = 0; $$(".tuile-mot.vide").forEach(b => b.classList.remove("vide")); maj(); };
    gestionTouches = e => { if (e.key === "Enter") verifier(); else if (e.key === "Escape") accueil(); };
  } else if (ex.mode === "type2") {
    const c1 = $("#saisie1"), c2 = $("#saisie2"), v = ex.verbe;
    setTimeout(() => c1.focus(), 50);
    c1.oninput = c2.oninput = () => { $("#verifier").disabled = !c1.value.trim() || !c2.value.trim(); };
    const verifier = () => {
      if (SESSION.repondu || !c1.value.trim() || !c2.value.trim()) return;
      const ok1 = corriger(c1.value, [v.pret, ...formes(v.pret)], true).juste, ok2 = corriger(c2.value, [v.part, ...formes(v.part)], true).juste;
      c1.classList.add(ok1 ? "juste" : "faux"); c2.classList.add(ok2 ? "juste" : "faux");
      c1.disabled = c2.disabled = true;
      repondre(ok1 && ok2);
    };
    $("#verifier").onclick = verifier;
    $("#passer").onclick = () => { if (!SESSION.repondu) { c1.disabled = c2.disabled = true; repondre(false); } };
    gestionTouches = e => {
      if (e.key === "Enter") { if (document.activeElement === c1 && !c2.value.trim()) c2.focus(); else verifier(); }
      else if (e.key === "Escape") accueil();
    };
  } else {
    const champ = $("#saisie");
    setTimeout(() => champ.focus(), 50);
    champ.oninput = () => { $("#verifier").disabled = !champ.value.trim(); };
    const verifier = () => {
      if (SESSION.repondu || !champ.value.trim()) return;
      const r = corriger(champ.value, ex.acceptes, ex.strict);
      champ.classList.add(r.juste ? "juste" : "faux");
      champ.disabled = true;
      repondre(r.juste, r.presque);
    };
    $("#verifier").onclick = verifier;
    $("#passer").onclick = () => { if (!SESSION.repondu) { champ.disabled = true; repondre(false); } };
    gestionTouches = e => { if (e.key === "Enter") verifier(); else if (e.key === "Escape") accueil(); };
  }
}

const BRAVOS = ["Bravo !", "Excellent !", "Parfait !", "Bien joué !", "Super !", "Génial !", "Impeccable !"];
function repondre(juste, presque) {
  const S = SESSION, ex = S.ex;
  S.repondu = true;
  if (!ex.nonMemo) {
    const avant = PROG.items[ex.id];
    const etaitFaible = avant && avant.ko >= 2 && (avant.c || 0) < 3;
    majMemoire(ex.id, juste, ex.production);
    if (etaitFaible && PROG.items[ex.id].c >= 3) {
      PROG.faiblesCorriges = (PROG.faiblesCorriges || 0) + 1;
      setTimeout(() => toast("🎯", "Point faible corrigé !", decrire(ex.id)), 400);
    }
  }
  if (ex.histoire !== undefined) {
    const sc = S.scores[ex.histoire] || (S.scores[ex.histoire] = { bonnes: 0, total: 0 });
    sc.total++; if (juste) sc.bonnes++;
  }
  if (!juste && S.partie && S.partie.ids.includes(ex.id)) S.erreursPartie++;
  let gain = 0;
  if (juste) {
    S.faits++; S.bonnes++; S.combo++;
    S.meilleurCombo = Math.max(S.meilleurCombo, S.combo);
    PROG.stats.meilleurCombo = Math.max(PROG.stats.meilleurCombo, S.combo);
    gain = 10 + (S.combo >= 3 ? 5 : 0) + (ex.production ? 3 : 0);
    S.xp += gain; gagnerXP(gain);
    PROG.stats.bonnes++;
    son("bon");
  } else {
    S.erreurs++; S.combo = 0;
    if (S.vies !== null) S.vies--;
    PROG.stats.mauvaises++;
    if (!ex.pasDeRelance) S.file.splice(Math.min(3, S.file.length), 0, { id: ex.id, mode: ex.modeCle || (ex.mode === "qcm" && ex.id[0] === "v" && ex.question === VBYID[ex.id]?.fr ? "qcm-inv" : ex.mode) });
    son("faux");
  }
  sauver();
  if (ex.verbe) setTimeout(() => direVerbe(ex.verbe), juste ? 350 : 150);
  else if (ex.audioReponse) setTimeout(() => parler(ex.audioReponse), juste ? 350 : 150);
  else if (ex.perso && ex.modeCle !== "trad") setTimeout(() => parler(ex.audioQuestion, false, ex.voix), juste ? 350 : 150);

  // mise à jour de la barre / des cœurs sans tout redessiner
  $(".ex-top .barre > div").style.width = `${100 * S.faits / Math.max(1, S.total)}%`;
  const coeurs = $(".coeurs");
  if (coeurs) coeurs.textContent = "❤️".repeat(Math.max(0, S.vies)) + "🖤".repeat(3 - Math.max(0, S.vies));

  const f = document.createElement("div");
  f.className = `feuille ${juste ? "ok" : "ko"}`;
  let txt;
  const rep = ex.verbe ? troisFormes(ex.verbe) : ex.repTexte || ex.bonne;
  if (juste && presque) txt = `<h3>Presque parfait !  +${gain} XP</h3><div class="rep">Attention à l'orthographe : ${esc(presque)}</div>`;
  else if (juste) txt = `<h3>${pick(BRAVOS)}  +${gain} XP</h3>${ex.verbe || ex.repTexte || (ex.mode !== "qcm" && ex.mode !== "listen") ? `<div class="rep">${esc(rep)}</div>` : ""}`;
  else txt = `<h3>Pas tout à fait…</h3><div class="rep">Bonne réponse : ${esc(rep)}</div>`;
  if (ex.astuce && (!juste || ex.id[0] === "p") && !(ex.perso && ex.modeCle !== "dictee")) txt += `<div class="exp">💡 ${md(ex.astuce)}</div>`;
  if (!juste && !ex.pasDeRelance) txt += `<div class="exp" style="opacity:.75">↻ Cette question reviendra un peu plus tard.</div>`;
  f.innerHTML = `<div class="int"><div class="grosse-ic">${juste ? "✅" : "❌"}</div><div class="txt">${txt}</div>
    <button class="btn ${juste ? "vert" : "rouge"} grand" id="continuer">Continuer</button></div>`;
  $(".ex").appendChild(f);
  $(".ex").classList.add("avec-feuille");
  $("#continuer").onclick = suivant;
  setTimeout(() => $("#continuer")?.focus(), 30);
  gestionTouches = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); suivant(); } else if (e.key === "Escape") accueil(); };
}

// ------------------------------------------------------------------ fin de session
function finSession(gagne) {
  const S = SESSION;
  let nbEtoiles = 0;
  const lignes = [];   // ce qui a été accompli, affiché sur l'écran de fin
  const etoilesTxt = n => "★".repeat(n) + "☆".repeat(3 - n);
  if (S.type === "lecon") {
    const info = PROG.lecons[S.i] || (PROG.lecons[S.i] = { etoiles: 0, tentatives: 0 });
    info.tentatives++;
    if (gagne) {
      nbEtoiles = S.erreurs === 0 ? 3 : S.erreurs === 1 ? 2 : 1;
      validerPartie(S.i, S.k, nbEtoiles);
      const bonus = 15 * nbEtoiles;
      S.xp += bonus; gagnerXP(bonus);
      if (etoiles(S.i) && S.k === 1) lignes.push(`🏁 Leçon ${S.i + 1} terminée ! La leçon suivante est débloquée.`);
    }
  } else if (gagne && S.total) {
    const bonus = S.type === "jour" ? 30 : 10; S.xp += bonus; gagnerXP(bonus);
    if (S.partie) {
      const n = 3 - Math.min(2, S.erreursPartie);
      validerPartie(S.partie.i, S.partie.k, n);
      lignes.push(`📘 Leçon ${S.partie.i + 1} · partie ${S.partie.k + 1} validée <span style="color:var(--or)">${etoilesTxt(n)}</span>`);
      if (S.partie.k === 1 && etoiles(S.partie.i)) lignes.push(`🏁 Leçon ${S.partie.i + 1} terminée ! La suivante est débloquée.`);
    }
    if (S.type === "jour") PROG.sessionJour = aujourdhui();
  }
  (S.scenesVues || []).forEach(s => {
    if (!gagne) return;
    const ids = idsScene(s), connues = ids.filter(id => (PROG.items[id]?.c || 0) > 0).length;
    PROG.scenes[s] = { date: aujourdhui(), connues };
    lignes.push(`🎬 « ${esc(CINE[s].titre)} » : ${connues} / ${ids.length} répliques réussies`);
  });
  Object.entries(S.scores).forEach(([s, sc]) => {
    const anc = PROG.histoires[s];
    PROG.histoires[s] = { score: Math.max(anc?.score || 0, sc.bonnes), date: aujourdhui() };
    lignes.push(`📖 « ${esc(HISTOIRES[s].titre)} » : ${sc.bonnes} / ${sc.total} bonnes réponses`);
  });
  PROG.stats.sessions++;
  PROG.stats.minutes = (PROG.stats.minutes || 0) + Math.max(1, Math.round((Date.now() - S.debut) / 60000));
  noterSuivi();
  celebrerNouveauxPaliers();
  const badges = verifierBadges();
  sauver();
  son(gagne ? "victoire" : "defaite");
  if (gagne) setTimeout(confettis, 150);
  badges.forEach((b, k) => setTimeout(() => { son("badge"); toast(b.ic, `Badge débloqué : ${b.nom}`, b.desc); }, 900 + k * 700));

  const precision = S.bonnes + S.erreurs ? Math.round(100 * S.bonnes / (S.bonnes + S.erreurs)) : 100;
  const duree = Math.max(1, Math.round((Date.now() - S.debut) / 60000));
  const objAtteint = (PROG.jours[aujourdhui()] || 0) >= PROG.objectif;
  let titre, sous, visuel;
  if (!gagne) {
    titre = "Plus de vies…"; visuel = `<div class="mascotte">💪</div>`;
    sous = `Pas grave ! Les phrases que tu as réussies restent en mémoire${S.k === 1 ? ", et la partie 1 reste acquise" : ""}. Relis la mini-leçon et réessaie.`;
  } else if (S.type === "lecon") {
    titre = nbEtoiles === 3 ? `Partie ${S.k + 1} parfaite !` : `Partie ${S.k + 1} réussie !`;
    sous = nbEtoiles === 3 ? "Zéro faute, impressionnant !" : `${S.erreurs} erreur${S.erreurs > 1 ? "s" : ""}. Rejoue plus tard pour décrocher les 3 étoiles.`;
    visuel = `<div class="grosses-etoiles">${[0, 1, 2].map(k => `<span class="${k < nbEtoiles ? "" : "vide"}" style="animation-delay:${0.25 + k * 0.25}s">⭐</span>`).join("")}</div>`;
  } else {
    titre = { pack: "Mots appris !", verbes: "Verbes appris !", jour: "Session du jour terminée !", faibles: "Points faibles travaillés !", histoire: "Histoire terminée !", cine: "Scène terminée ! 🎬", fragiles: "Mots fragiles révisés !" }[S.type] || "Révisions terminées !";
    sous = S.type === "jour" ? "Grammaire, vocabulaire, écoute, lecture : tu as tout travaillé aujourd'hui 💪" : "Ta mémoire te remercie. Ces éléments reviendront au moment idéal.";
    visuel = `<div class="mascotte">${S.type === "jour" ? "🏆" : "🎉"}</div>`;
  }

  // suite logique d'une leçon : partie 2, puis leçon suivante
  const cibleSuite = S.type !== "lecon" ? null : !gagne ? [S.i, S.k] : S.k === 0 ? [S.i, 1] : S.i + 1 < LECONS.length ? [S.i + 1, 0] : [S.i, S.k];
  const libelleSuite = !cibleSuite ? "" : !gagne ? "Réessayer" : S.k === 0 ? "Partie 2 →" : S.i + 1 < LECONS.length ? "Leçon suivante →" : "Rejouer";
  const suiteLecon = S.type === "lecon" && gagne;
  gestionTouches = null;
  $("#app").innerHTML = `<div class="contenu" style="display:flex"><div class="fin screen">
    ${visuel}<h1>${titre}</h1><p class="sous">${sous}</p>
    <div class="resume">
      <div class="stat or"><strong>+${S.xp}</strong><span>XP gagnés</span></div>
      <div class="stat vert"><strong>${precision} %</strong><span>Précision</span></div>
      <div class="stat bleu"><strong>${S.meilleurCombo}</strong><span>Meilleur combo</span></div>
    </div>
    ${lignes.length ? `<div class="accomplis">${lignes.map(l => `<div>${l}</div>`).join("")}</div>` : ""}
    ${objAtteint ? `<p class="sous">✅ Objectif du jour atteint · série de <b>${serieActuelle()}</b> jour${serieActuelle() > 1 ? "s" : ""} 🔥 · ${duree} min</p>` : `<p class="sous">${PROG.jours[aujourdhui()] || 0} / ${PROG.objectif} XP aujourd'hui · ${duree} min</p>`}
    <div class="actions">
      <button class="btn gris grand" id="maison">Accueil</button>
      ${cibleSuite ? `<button class="btn ${suiteLecon ? "vert" : ""} grand" id="suite">${libelleSuite}</button>` : ""}
    </div></div></div>`;
  $("#maison").onclick = accueil;
  const suite = $("#suite");
  const actionSuite = suite ? () => lancerLecon(...cibleSuite) : accueil;
  if (suite) suite.onclick = actionSuite;
  gestionTouches = e => { if (e.key === "Enter") actionSuite(); else if (e.key === "Escape") accueil(); };
}

// ------------------------------------------------------------------ confettis
function confettis() {
  const c = $("#confetti"), ctx = c.getContext("2d");
  c.width = innerWidth; c.height = innerHeight;
  const cols = ["#7c5cff", "#22d3a6", "#ffc83d", "#ff5c7a", "#4cc9ff", "#ffffff"];
  const parts = Array.from({ length: 180 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 260, y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 15 - 5, r: Math.random() * 7 + 5,
    c: pick(cols), a: Math.random() * 6, va: (Math.random() - 0.5) * 0.35,
  }));
  let t = 0;
  const debut = performance.now();
  setTimeout(() => { t = 999; ctx.clearRect(0, 0, c.width, c.height); }, 3600);   // si l'animation est mise en pause
  (function image() {
    if (performance.now() - debut > 3500) t = 999;   // ne traîne jamais, même si l'animation est ralentie
    ctx.clearRect(0, 0, c.width, c.height);
    parts.forEach(p => {
      p.vy += 0.33; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.a += p.va;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c;
      ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); ctx.restore();
    });
    if (++t < 200) requestAnimationFrame(image); else ctx.clearRect(0, 0, c.width, c.height);
  })();
}
