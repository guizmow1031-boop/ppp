// ========================================
// IMPORT FIREBASE
// ========================================
import { auth, db, googleProvider } from './firebase.js';
import { onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { doc, getDoc, setDoc, updateDoc } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

console.log("📄 script.js chargé !");

// ========================================
// VARIABLES GLOBALES
// ========================================
let currentUser = null;
let currentCredits = 0;
let starterCreditsAvailable = false;
const STARTER_CHECKOUT_URL = 'https://buy.stripe.com/bJe14g8GRdqn5V41mxafS00';
const PENDING_ACTION_KEY = 'pendingAction';
const REDIRECT_IN_PROGRESS_KEY = 'googleRedirectInProgress';
let redirectResultResolved = false;
let redirectResultPromise = null;

// ========================================
// AIDE ERREURS AUTH GOOGLE
// ========================================
function getAuthErrorMessage(error) {
    const code = error?.code || '';

    if (code === 'auth/unauthorized-domain') {
        return '❌ Domaine non autorisé. Ajoutez guizmow1031-boop.github.io dans Firebase Auth > Authorized domains.';
    }

    if (code === 'auth/popup-blocked') {
        return '❌ Popup bloquée. Autorisez les popups puis réessayez.';
    }

    if (code === 'auth/popup-closed-by-user') {
        return '⚠️ Connexion annulée. Réessayez et acceptez la fenêtre Google.';
    }

    if (code === 'auth/operation-not-allowed') {
        return '❌ Google Sign-In est désactivé. Activez-le dans Firebase Authentication.';
    }

    if (code === 'auth/invalid-api-key') {
        return '❌ Clé API invalide. Vérifiez la configuration Firebase.';
    }

    if (code === 'auth/network-request-failed') {
        return '❌ Problème réseau. Vérifiez la connexion internet.';
    }

    return '❌ Connexion Google requise pour accéder au site.';
}

// ========================================
// UTILITAIRES AUTH (POPUP VS REDIRECT)
// ========================================
const isMobileDevice = () => {
    const ua = navigator.userAgent || navigator.vendor || window.opera;
    return /android|iphone|ipad|ipod|mobile|silk/i.test(ua);
};

async function signInWithGoogle() {
    if (isMobileDevice()) {
        console.log('📱 Mobile détecté: login via redirect');
        try {
            localStorage.setItem(REDIRECT_IN_PROGRESS_KEY, '1');
        } catch (e) {
            console.warn('⚠️ Impossible de marquer le redirect Google', e);
        }
        await signInWithRedirect(auth, googleProvider);
        return null;
    }

    console.log('🖥️ Desktop détecté: login via popup');
    return await signInWithPopup(auth, googleProvider);
}

function isRedirectInProgress() {
    try {
        return localStorage.getItem(REDIRECT_IN_PROGRESS_KEY) === '1';
    } catch (e) {
        return false;
    }
}

function clearRedirectInProgress() {
    try {
        localStorage.removeItem(REDIRECT_IN_PROGRESS_KEY);
    } catch (e) {
        // ignore
    }
}

function setPendingAction(action, options = { overwrite: false }) {
    if (!action) return;
    try {
        const existing = sessionStorage.getItem(PENDING_ACTION_KEY);
        if (existing && !options.overwrite) return;
        sessionStorage.setItem(PENDING_ACTION_KEY, action);
    } catch (e) {
        console.warn('⚠️ Impossible de sauvegarder l’action en attente', e);
    }
}

function consumePendingAction() {
    try {
        const action = sessionStorage.getItem(PENDING_ACTION_KEY);
        if (action) sessionStorage.removeItem(PENDING_ACTION_KEY);
        return action;
    } catch (e) {
        return null;
    }
}

function handlePendingAction() {
    const action = consumePendingAction();
    if (!action) return;

    if (action === 'starterCheckout') {
        if (currentUser && !currentUser.isAnonymous) {
            showStarterForm();
        }
        return;
    }

    if (action.startsWith('click:')) {
        const id = action.replace('click:', '');
        const el = document.getElementById(id);
        if (el) {
            el.click();
        }
        return;
    }

    if (action.startsWith('href:')) {
        const url = action.replace('href:', '');
        if (url) {
            window.location.href = url;
        }
        return;
    }
}

// Finaliser un éventuel redirect Google
redirectResultPromise = getRedirectResult(auth)
    .then((result) => {
        if (result && result.user) {
            console.log('✅ Redirect Google terminé');
            currentUser = result.user;
            updateAuthUI(result.user);
            handlePendingAction();
        }
    })
    .catch((error) => {
        if (error?.code) {
            console.error('❌ Erreur redirect Google:', error.code, error.message);
        }
        alert(getAuthErrorMessage(error));
    })
    .finally(() => {
        clearRedirectInProgress();
        redirectResultResolved = true;
    });

// ========================================
// AUTHENTIFICATION ET GESTION CRÉDITS FIRESTORE
// ========================================
onAuthStateChanged(auth, async (user) => {
    if (!redirectResultResolved && redirectResultPromise) {
        try {
            await redirectResultPromise;
        } catch (e) {
            // ignore
        }
    }
    if (user) {
        // Utilisateur connecté (Google)
        currentUser = user;
        console.log("✅ Utilisateur connecté !");
        console.log("UID:", user.uid);
        console.log("Type:", user.isAnonymous ? "Anonyme" : "Identifié");
        if (user.email) {
            console.log("📧 Email:", user.email);
        }

        // Initialiser les crédits depuis Firestore
        await initFirestoreCredits();

        // Mettre à jour l'affichage du profil
        updateAuthUI(user);

        // Exécuter action en attente après login
        handlePendingAction();
    } else {
        // Pas d'utilisateur, connexion Google obligatoire
        console.log("🔒 Connexion Google requise...");
        updateAuthUI(null);
        if (isRedirectInProgress()) {
            console.log('⏳ Redirect Google en cours, attente du résultat...');
        }
        // Ne pas relancer automatiquement la connexion ici pour éviter les boucles.
        // La connexion est demandée uniquement lors d'une action utilisateur (ensureGoogleAuth).
    }
});

// ========================================
// FONCTION D'AUTHENTIFICATION GOOGLE
// ========================================

/**
 * Assure que l'utilisateur est connecté avec Google
 * - Si non connecté : demande la connexion Google
 * - Si déjà connecté avec Google : retourne directement
 */
async function ensureGoogleAuth() {
    console.log("🔍 Vérification de l'authentification...");
    
    // Si pas d'utilisateur courant, on déclenche la connexion
    if (!currentUser) {
        console.log("ℹ️ Aucun utilisateur détecté, lancement connexion...");
        const result = await signInWithGoogle();
        if (!result || !result.user) {
            // En mode redirect, la page va se recharger
            return null;
        }
        currentUser = result.user;
        await updateUserDocument();
        updateAuthUI(result.user);
        return result.user;
    }
    
    // Si l'utilisateur est déjà connecté avec Google
    if (currentUser && !currentUser.isAnonymous) {
        console.log("✅ Déjà connecté avec Google:", currentUser.email);
        console.log("🔑 UID conservé:", currentUser.uid);
        return currentUser;
    }

    // Pas connecté, on demande Google
    console.log("🔗 Connexion Google requise...");
    try {
        const result = await signInWithGoogle();
        if (!result || !result.user) {
            // En mode redirect, la page va se recharger
            return null;
        }
        console.log("✅ Connexion Google réussie");
        currentUser = result.user;
        await updateUserDocument();
        updateAuthUI(result.user);
        return result.user;
    } catch (error) {
        alert(getAuthErrorMessage(error));
        console.error("❌ Erreur lors de la connexion Google:", error);
        throw error;
    }
}

/**
 * Met à jour le document Firestore de l'utilisateur avec l'email
 * IMPORTANT: Ne touche PAS aux crédits existants
 */
async function updateUserDocument() {
    if (!currentUser) return;
    
    const uid = currentUser.uid;
    const userRef = doc(db, "users", uid);
    
    try {
        const docSnap = await getDoc(userRef);
        
        const userData = {
            email: currentUser.email || null,
            lastLogin: new Date().toISOString()
        };
        
        if (!docSnap.exists()) {
            // Document n'existe pas (ne devrait pas arriver car créé en anonyme)
            userData.credits = 10;
            await setDoc(userRef, userData);
            console.log("📝 Document utilisateur créé avec email et 10 crédits");
        } else {
            // Document existe déjà, on met à jour UNIQUEMENT l'email et lastLogin
            // Les crédits existants sont PRÉSERVÉS
            const existingCredits = docSnap.data().credits;
            await updateDoc(userRef, userData);
            console.log("📝 Document utilisateur mis à jour avec email");
            console.log("💎 Crédits préservés:", existingCredits);
        }
    } catch (error) {
        console.error("❌ Erreur mise à jour document:", error);
    }
}

// ========================================
// UI AUTH (Boutons login / profil)
// ========================================

function updateAuthUI(user) {
    const profileBox = document.getElementById('profile-box');
    const profileName = document.getElementById('profile-name');
    const profileEmail = document.getElementById('profile-email');
    const profilePhoto = document.getElementById('profile-photo');

    if (!profileBox) return;

    if (user && !user.isAnonymous) {
        // Utilisateur Google connecté
        profileBox.style.display = 'flex';

        const displayName = user.displayName || 'Compte';
        const email = user.email || '';
        const photoURL = user.photoURL || '';

        if (profileName) profileName.textContent = displayName;
        if (profileEmail) profileEmail.textContent = email;

        if (profilePhoto) {
            if (photoURL) {
                profilePhoto.src = photoURL;
                profilePhoto.style.display = 'block';
            } else {
                profilePhoto.removeAttribute('src');
                profilePhoto.style.display = 'none';
            }
        }
    } else {
        // Utilisateur non connecté
        profileBox.style.display = 'none';
    }
}

function setupAuthButtons() {
    // Boutons supprimés
}

// ========================================
// FORMULAIRE POST-PAIEMENT STARTER (EmailJS)
// ========================================

function showStarterForm() {
    const modal = document.getElementById('starter-form-modal');
    if (modal) modal.style.display = 'flex';
}

function hideStarterForm() {
    const modal = document.getElementById('starter-form-modal');
    if (modal) modal.style.display = 'none';
}

async function addCreditsAndRedirect(sourceButton) {
    const updated = await addCredits(100);
    if (!updated) {
        alert('❌ Erreur lors de la mise à jour des crédits.');
        return;
    }

    updateCreditsDisplay();
    showGuidanceTooltip('💎 100 crédits ajoutés !', 'bottom-left');

    if (sourceButton) {
        sourceButton.disabled = true;
        sourceButton.textContent = '✅ +100';
    }

    window.location.href = STARTER_CHECKOUT_URL;
}

async function addCreditsAndHide(sourceButton) {
    if (sourceButton && sourceButton.dataset.locked === 'true') {
        return;
    }

    if (sourceButton) {
        sourceButton.dataset.locked = 'true';
        sourceButton.style.display = 'none';
    }

    const updated = await addCredits(100);
    if (!updated) {
        alert('❌ Erreur lors de la mise à jour des crédits.');
        if (sourceButton) {
            sourceButton.style.display = 'inline-flex';
        }
        return;
    }

    await setStarterCreditsAvailability(false);

    updateCreditsDisplay();
    showGuidanceTooltip('💎 100 crédits ajoutés !', 'bottom-left');
}

async function setStarterCreditsAvailability(isAvailable) {
    if (!currentUser) return;

    try {
        const userRef = doc(db, "users", currentUser.uid);
        await updateDoc(userRef, { starterCreditsAvailable: isAvailable });
        starterCreditsAvailable = isAvailable;
        updateStarterCreditsButton();
    } catch (error) {
        console.error('❌ Erreur mise à jour disponibilité crédits Starter:', error);
    }
}

function updateStarterCreditsButton() {
    const navAddCreditsBtn = document.getElementById('nav-add-credits');
    if (!navAddCreditsBtn) return;

    navAddCreditsBtn.style.display = starterCreditsAvailable ? 'inline-flex' : 'none';
    if (!starterCreditsAvailable) {
        navAddCreditsBtn.dataset.locked = 'false';
    }
}

function setupStarterForm() {
    const modal = document.getElementById('starter-form-modal');
    const closeBtn = document.getElementById('starter-form-close');
    const form = document.getElementById('starter-form');
    const addCreditsBtn = document.getElementById('starter-add-credits');

    if (closeBtn) {
        closeBtn.addEventListener('click', hideStarterForm);
    }

    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) hideStarterForm();
        });
    }

    if (addCreditsBtn) {
        addCreditsBtn.addEventListener('click', async () => {
            addCreditsBtn.style.display = 'none';
            await addCreditsAndRedirect(addCreditsBtn);
        });
    }

    if (form) {
        form.addEventListener('submit', (e) => {
            e.preventDefault();

            const emailInput = document.getElementById('starter-email');
            const phoneInput = document.getElementById('starter-phone');

            const email = emailInput ? emailInput.value.trim() : '';
            const phone = phoneInput ? phoneInput.value.trim() : '';

            if (!email) {
                alert('❌ L\'email est obligatoire.');
                return;
            }

            const templateParams = {
                to_email: 'guizmow1031@gmail.com',
                user_email: email,
                user_phone: phone || 'Non renseigné',
                user_uid: currentUser ? currentUser.uid : 'Inconnu'
            };

            emailjs.send('default_service', 'template_starter', templateParams)
                .then(() => {
                    console.log('✅ Email envoyé, affichage bouton crédits');
                    if (addCreditsBtn) {
                        addCreditsBtn.style.display = 'inline-block';
                    }
                    setStarterCreditsAvailability(true);
                })
                .catch((error) => {
                    console.error('❌ Erreur EmailJS:', error);
                    alert('❌ Erreur lors de l\'envoi.');
                });
        });
    }
}

// ========================================
// BLOQUER ACTIONS SI PAS CONNECTÉ
// ========================================

function setupAuthGateForClicks() {
    document.addEventListener('click', async (event) => {
        const target = event.target;
        if (!target) return;

        const clickable = target.closest('button, a');
        if (!clickable) return;

        // Si l'utilisateur est connecté Google, autoriser
        if (currentUser && !currentUser.isAnonymous) return;

        // Mémoriser l'action à rejouer après login
        const clickableId = clickable.getAttribute('id');
        const href = clickable.getAttribute('href');

        if (clickableId) {
            setPendingAction(`click:${clickableId}`);
        } else if (href && !href.startsWith('javascript:')) {
            setPendingAction(`href:${href}`);
        }

        // Bloquer l'action et demander connexion Google
        event.preventDefault();
        event.stopPropagation();

        try {
            await ensureGoogleAuth();
        } catch (error) {
            console.error('❌ Connexion requise:', error);
        }
    }, true);
}

// ========================================
// STRIPE CHECKOUT - PLAN STARTER
// ========================================

async function startStarterCheckout() {
    console.log('💳 Démarrage paiement Starter');

    try {
        if (!currentUser || currentUser.isAnonymous) {
            setPendingAction('starterCheckout');
        }

        const authResult = await ensureGoogleAuth();
        if (authResult === null) return;

        if (!currentUser || currentUser.isAnonymous) {
            alert('❌ Vous devez être connecté avec Google pour payer.');
            return;
        }

        console.log('✅ Auth confirmée, affichage du formulaire');
        showStarterForm();
    } catch (error) {
        console.error('❌ Erreur paiement Starter:', error);
        alert('❌ Erreur lors de la connexion.');
    }
}

// ========================================
// SYSTÈME DE CRÉDITS FIRESTORE
// ========================================

// Initialiser les crédits depuis Firestore
async function initFirestoreCredits() {
    if (!currentUser) return;

    const uid = currentUser.uid;
    const userRef = doc(db, "users", uid);

    console.log("📊 Chargement des crédits pour UID:", uid);

    try {
        const docSnap = await getDoc(userRef);

        if (!docSnap.exists()) {
            // Premier chargement : créer le document avec 10 crédits
            await setDoc(userRef, {
                credits: 10,
                createdAt: new Date().toISOString(),
                isAnonymous: currentUser.isAnonymous
            });
            currentCredits = 10;
            console.log("📝 NOUVEAU document créé: users/" + uid);
            console.log("💎 Crédits initiaux: 10");
        } else {
            // Document existe : récupérer les crédits
            currentCredits = docSnap.data().credits || 0;
            starterCreditsAvailable = docSnap.data().starterCreditsAvailable === true;
            console.log("📂 Document EXISTANT chargé: users/" + uid);
            console.log("💎 Crédits chargés:", currentCredits);
        }

        // Mettre à jour l'affichage
        updateCreditsDisplay();
        updateStarterCreditsButton();

        // Configurer le bouton de dépense de crédits
        setupCreditButton();

    } catch (error) {
        console.error("❌ Erreur Firestore:", error);
    }
}

// Fonction pour obtenir le nombre de crédits
function getCredits() {
    return currentCredits;
}

// Fonction pour déduire des crédits
async function deductCredits(amount) {
    if (!currentUser) {
        console.error("❌ Aucun utilisateur connecté");
        return false;
    }
    
    if (currentCredits < amount) {
        alert("❌ Crédits insuffisants !");
        return false;
    }
    
    const uid = currentUser.uid;
    const userRef = doc(db, "users", uid);
    const newCredits = currentCredits - amount;
    
    try {
        // Mettre à jour Firestore
        await updateDoc(userRef, { credits: newCredits });
        currentCredits = newCredits;
        
        console.log(`✅ ${amount} crédit(s) déduit(s). Reste : ${newCredits}`);
        
        // Mettre à jour l'affichage
        updateCreditsDisplay();
        
        return true;
    } catch (error) {
        console.error("❌ Erreur lors de la déduction:", error);
        return false;
    }
}

// Fonction pour ajouter des crédits
async function addCredits(amount) {
    if (!currentUser) {
        console.error("❌ Aucun utilisateur connecté");
        return false;
    }
    
    const uid = currentUser.uid;
    const userRef = doc(db, "users", uid);
    const newCredits = currentCredits + amount;
    
    try {
        // Mettre à jour Firestore
        await updateDoc(userRef, { credits: newCredits });
        currentCredits = newCredits;
        
        console.log(`✅ ${amount} crédit(s) ajouté(s). Total : ${newCredits}`);
        
        // Mettre à jour l'affichage
        updateCreditsDisplay();
        
        return true;
    } catch (error) {
        console.error("❌ Erreur lors de l'ajout:", error);
        return false;
    }
}

// Définir les crédits à une valeur précise
async function setCredits(amount) {
    if (!currentUser) {
        console.error("❌ Aucun utilisateur connecté");
        return false;
    }

    const uid = currentUser.uid;
    const userRef = doc(db, "users", uid);

    try {
        await updateDoc(userRef, { credits: amount });
        currentCredits = amount;
        updateCreditsDisplay();
        console.log(`✅ Crédits définis à : ${amount}`);
        return true;
    } catch (error) {
        console.error("❌ Erreur lors de la mise à jour des crédits:", error);
        return false;
    }
}

// Fonction pour mettre à jour l'affichage des crédits
function updateCreditsDisplay() {
    const creditCounter = document.getElementById('credit-counter');
    const creditsDisplay = document.getElementById('credits-display');
    const spendButton = document.getElementById('spend-credit');
    
    if (creditCounter) {
        creditCounter.textContent = currentCredits;
    }
    
    if (creditsDisplay) {
        if (currentCredits <= 0) {
            creditsDisplay.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
            creditsDisplay.title = "Crédits épuisés ! Contactez-nous pour recharger.";
        } else {
            creditsDisplay.style.background = 'linear-gradient(135deg, #a855f7, #7c3aed)';
            creditsDisplay.title = `${currentCredits} crédit(s) disponible(s)`;
        }
    }
    
    // Afficher le bouton de test une fois les crédits chargés
    if (spendButton && currentUser) {
        spendButton.style.display = 'inline-block';
    }
}

// resetCredits supprimé

// ========================================
// GESTION BOUTON DÉPENSE DE CRÉDITS
// ========================================

// Fonction pour configurer le bouton de dépense de crédits
function setupCreditButton() {
    const creditButton = document.getElementById('spend-credit');
    const creditCounter = document.getElementById('credit-counter');
    
    if (!creditButton) {
        console.warn("⚠️ Bouton 'spend-credit' introuvable");
        return;
    }
    
    creditButton.addEventListener("click", async () => {
        console.log("🎯 Clic sur 'spend-credit' (TEST)");
        
        // Bouton de test simple - PAS d'authentification Google nécessaire
        if (!currentUser) {
            alert("❌ Aucun utilisateur connecté");
            return;
        }
        
        if (currentCredits > 0) {
            console.log(`💳 Tentative de déduction - Crédits actuels: ${currentCredits}`);
            
            const uid = currentUser.uid;
            const userRef = doc(db, "users", uid);
            
            currentCredits--; // décrémente la valeur
            
            try {
                await updateDoc(userRef, { credits: currentCredits });
                console.log("✅ Crédit déduit dans Firestore");
                
                if (creditCounter) {
                    creditCounter.textContent = currentCredits;
                }
                
                console.log(`💎 Crédit dépensé avec succès! Nouveau total: ${currentCredits}`);
                
                // Mettre à jour l'affichage complet
                updateCreditsDisplay();
                
            } catch (error) {
                console.error("❌ Erreur mise à jour Firestore:", error);
                currentCredits++; // Restaurer si échec
                alert("❌ Erreur lors de la mise à jour des crédits");
            }
        } else {
            console.warn("⚠️ Crédits épuisés!");
            alert("❌ Crédit épuisé ! Contactez-nous pour recharger.");
        }
    });
    
    console.log("✅ Bouton de dépense de crédits configuré");
}

// Fonction pour basculer les portails électriques
function togglePortal(portalElement) {
    portalElement.classList.toggle('active');
}

// Fonction pour ouvrir les jeux
function openGame(gamePath) {
    const basePath = window.location.href.split('/gg/')[0];
    const fullPath = basePath + '/' + gamePath + '/index.html';
    window.location.href = fullPath;
}

// État du formulaire
let currentStep = 0;
const formData = {};

// Questions
const questions = [
    { id: 'siteType', title: 'Quel type de site veux-tu créer ?', type: 'choice', options: ['🏢 Site business', '📁 Portfolio / CV en ligne', '🛍️ E-commerce / Boutique', '📝 Blog / Magazine', '👥 Réseau social / Communauté', '🎓 Plateforme éducative'] },
    { id: 'projectName', title: 'Quel est le nom de ton projet ?', type: 'text', placeholder: 'Ex: Ma Super Boutique...' },
    { id: 'mainGoal', title: 'Quel est le but principal de ton site ?', type: 'choice', options: ['💰 Vendre des produits', '📅 Recevoir des réservations', '📢 Présenter mon activité', '📇 Gérer des contacts', '🎨 M\'amuser avec mon imagination', '💡 Partager des idées / contenu', '✨ Autre (préciser)'], hasOther: true, otherId: 'otherGoal' },
    { id: 'elementTypes', title: '❓ Quels types d\'éléments doit contenir l\'outil ?', subtitle: 'Ex : catégories, pages swipables, boutons interactifs, formulaire, liste, slider, carte, tableau…', type: 'textarea', placeholder: 'Ex: Catégories, boutons interactifs, formulaire de contact...' },
    { id: 'styleVibe', title: 'Quel vibe ou style tu veux ?', type: 'choice-grid', options: ['✨ Moderne', '💎 Luxe', '🎉 Fun', '⚪ Minimaliste', '🤖 Cyberpunk', '📻 Rétro', '🌑 Sombre', '☀️ Clair', '🌈 Coloré', '💼 Pro', '🎨 Couleurs perso'], hasOther: true, otherId: 'customColors', otherLabel: 'Ex: Rose et bleu...' },
    { id: 'pageTypes', title: 'Quel type de pages tu veux ? (plusieurs choix)', type: 'multi-choice', options: ['🏠 Accueil', '📂 Catégories', '👤 À propos', '📧 Contact', '🛒 Boutique', '🍽️ Menu / Carte', '📅 Réservation', '📝 Blog / Articles', '🖼️ Portfolio / Galerie', '👥 Pages membres'], hasText: true, textId: 'otherPage', textPlaceholder: 'Autre type de page ?' },
    { id: 'contentToShow', title: 'Qu\'est-ce que tu veux montrer exactement ?', type: 'textarea', placeholder: 'Ex: Des plats de restaurant, Mes services de coaching...' },
    { id: 'additionalInfo', title: 'As-tu des textes ou des infos à ajouter ?', type: 'textarea', placeholder: 'Ex: Adresse, Téléphone, Horaires, Bio...' },
    { id: 'sitePurpose', title: 'Tu veux que ton site fasse quoi ? (plusieurs choix)', type: 'multi-choice', options: ['📅 Prendre rendez-vous', '🛍️ Vendre en ligne', '💬 Recevoir des messages', '🍽️ Afficher un menu personnalisé', '📸 Montrer des photos', '✨ Créer une interactivité unique', '🔐 Avoir un espace membre', '👥 Créer une communauté'], hasText: true, textId: 'otherPurpose', textPlaceholder: 'Autre fonction ?' },
    { id: 'siteStyle', title: 'Ton site doit être style :', type: 'choice', options: ['🎉 Fun', '💼 Professionnel', '🎨 Créatif', '😌 Décontracté', '🏆 Premium', '🤝 Convivial'], hasText: true, textId: 'customStyle', textPlaceholder: 'Ou un mélange ?' },
    { id: 'similarSite', title: 'Ton site doit ressembler à quoi ?', type: 'textarea', placeholder: 'Ex: Un site de restaurant, Un réseau social...' },
    { id: 'magicMachine', title: '❓ Si mon site était une machine magique, que permettrait-il de faire instantanément ?', type: 'textarea', placeholder: 'Ex: Permettre aux gens de commander ma cuisine en 2 clics, créer des communautés instantanément...' },
    { id: 'visionPhrase', title: '⭐ Décris-moi la vision de ton site en une phrase', subtitle: 'C\'est LA question la plus importante ! 🚀', type: 'textarea-important', placeholder: 'Ma vision : ...', examples: ['Un site pour vendre mes t-shirts stylés', 'Un site pour prendre des rendez-vous facilement', 'Un site de blagues pour partager avec mes amis', 'Une plateforme pour montrer mon portfolio créatif'] },
    { id: 'email', title: '📧 Quelle est ton adresse email ?', type: 'email', placeholder: 'Ex: tonemail@exemple.com', info: 'Je t\'enverrai le lien de ton site terminé à cette adresse. Tu seras le seul à y avoir accès ! 🔒' }
];

async function showFormPage() {
    console.log("🎯 Démarrage création de site...");
    
    // ÉTAPE 1 : Vérifier les crédits
    const currentCredits = getCredits();
    if (currentCredits < 10) {
        alert('❌ CRÉDITS INSUFFISANTS !\n\n' +
              'Il vous faut 10 crédits pour créer un site.\n' +
              'Vous avez actuellement : ' + currentCredits + ' crédit(s).\n\n' +
              '💡 Contactez-nous pour obtenir plus de crédits !');
        return;
    }
    
    // ÉTAPE 2 : Demander la connexion Google AVANT de démarrer
    try {
        console.log("🔐 Authentification Google requise pour créer un site...");
        const authResult = await ensureGoogleAuth();
        if (authResult === null) return;
        console.log("✅ Authentification confirmée, démarrage du formulaire...");
    } catch (error) {
        console.error("❌ Erreur authentification:", error);
        if (error.message === "Connexion annulée") {
            alert("⚠️ Connexion annulée. Vous devez vous connecter avec Google pour créer un site.");
        } else {
            alert("❌ Erreur lors de la connexion. Veuillez réessayer.");
        }
        return;
    }
    
    // ÉTAPE 3 : Déduire 10 crédits
    const success = await deductCredits(10);
    if (!success) {
        alert("❌ Erreur lors de la déduction des crédits.");
        return;
    }
    
    // ÉTAPE 4 : Afficher la page du formulaire
    document.getElementById('landing-page').classList.remove('active');
    document.getElementById('form-page').classList.add('active');
    document.getElementById('success-message').classList.remove('show');
    window.scrollTo(0, 0);
    renderQuestion();
    showGuidanceTooltip('✨ Réponds à quelques questions et crée ton site en minutes !', 'bottom-left');
}

// Exposer showFormPage globalement pour qu'elle soit accessible depuis le HTML
window.showFormPage = showFormPage;
console.log('✅ showFormPage exposée globalement');

function showLandingPage() {
    document.getElementById('form-page').classList.remove('active');
    document.getElementById('landing-page').classList.add('active');
    window.scrollTo(0, 0);
}

// Services informatiques disponibles
const informaticServices = [
    {
        id: 'consultation',
        icon: '💬',
        name: 'Consultation Technique',
        description: 'Besoin de conseils sur votre projet informatique ? Notre expert vous aide à trouver la meilleure solution.'
    },
    {
        id: 'formation',
        icon: '📚',
        name: 'Formation Informatique',
        description: 'Formations personnalisées en développement web, SEO, marketing digital et bien plus !'
    },
    {
        id: 'integration',
        icon: '🔧',
        name: 'Intégration & Maintenance',
        description: 'Intégration de services, maintenance régulière et support technique complet pour votre site.'
    },
    {
        id: 'seo',
        icon: '🔍',
        name: 'Optimisation SEO',
        description: 'Améliez votre visibilité en ligne avec nos services d\'optimisation SEO professionnels.'
    },
    {
        id: 'ecommerce',
        icon: '🛒',
        name: 'Boutique E-commerce',
        description: 'Créez une boutique en ligne performante et sécurisée pour vendre vos produits.'
    },
    {
        id: 'security',
        icon: '🛡️',
        name: 'Sécurité & Protection',
        description: 'Sécurisez votre site avec SSL, backups réguliers et protection contre les cybermenaces.'
    },
    {
        id: 'analytics',
        icon: '📊',
        name: 'Analytics & Reporting',
        description: 'Suivez vos performances avec des rapports détaillés et conseils d\'amélioration.'
    },
    {
        id: 'email-marketing',
        icon: '📧',
        name: 'Email Marketing',
        description: 'Créez des campagnes email efficaces pour fidéliser vos clients et augmenter vos ventes.'
    },
    {
        id: 'social-media',
        icon: '📱',
        name: 'Gestion Réseaux Sociaux',
        description: 'Gestion complète de vos présences sur les réseaux sociaux avec contenu professionnel.'
    },
    {
        id: 'design',
        icon: '🎨',
        name: 'Design Graphique',
        description: 'Création de logos, bannières et visuels professionnels pour votre marque.'
    }
];

let selectedService = null;

// Outils informatiques
const computerTools = [
    {
        id: 'calculator',
        icon: '🧮',
        name: 'Calculatrice Pro',
        description: 'Calculatrice scientifique avec fonctions avancées',
        info: 'Calculatrice complète pour calculs simples et scientifiques. Utile pour les mathématiques, la programmation et les finances.',
        link: 'https://www.calculator.net/'
    },
    {
        id: 'calendar',
        icon: '📅',
        name: 'Calendrier 2026',
        description: 'Calendrier interactif avec gestion des événements',
        info: 'Consulter les dates, jours fériés et planifier vos événements. Synchronisez-le avec vos rappels et tâches.',
        link: 'https://www.timeanddate.com/calendar/'
    },
    {
        id: 'converter-units',
        icon: '🔄',
        name: 'Convertisseur d\'Unités',
        description: 'Convertissez longueurs, poids, volume et plus',
        info: 'Convertisseur universel pour toutes les unités : longueur, poids, volume, température, vitesse, etc.',
        link: 'https://www.unitconverters.net/'
    },
    {
        id: 'currency',
        icon: '💱',
        name: 'Convertisseur de Devises',
        description: 'Conversion de devises en temps réel',
        info: 'Convertissez n\'importe quelle devise en temps réel avec les taux de change actualisés instantanément.',
        link: 'https://www.xe.com/'
    },
    {
        id: 'text-editor',
        icon: '📝',
        name: 'Éditeur de Texte',
        description: 'Éditeur de texte simple et efficace',
        info: 'Écrivez et éditez du texte en ligne. Parfait pour la prise de notes, la rédaction et la composition.',
        link: 'https://www.textpad.com/'
    },
    {
        id: 'color-generator',
        icon: '🎨',
        name: 'Générateur de Couleurs',
        description: 'Générez des palettes de couleurs harmonieuses',
        info: 'Créez des palettes de couleurs magnifiques et harmonieuses pour vos designs web, graphiques ou projets créatifs.',
        link: 'https://coolors.co/'
    },
    {
        id: 'password-generator',
        icon: '🔐',
        name: 'Générateur de Mot de Passe',
        description: 'Créez des mots de passe sécurisés',
        info: 'Générez des mots de passe forts et sécurisés. Personnalisez la longueur et les caractères pour plus de sécurité.',
        link: 'https://www.lastpass.com/features/password-generator'
    },
    {
        id: 'imc-calculator',
        icon: '⚖️',
        name: 'Calculateur d\'IMC',
        description: 'Calculez votre indice de masse corporelle',
        info: 'Calculez votre IMC et recevez des recommandations de santé basées sur vos mesures et votre poids.',
        link: 'https://www.calcbmi.com/'
    },
    {
        id: 'loan-calculator',
        icon: '💰',
        name: 'Calculateur de Prêt',
        description: 'Simulez vos paiements de prêt',
        info: 'Simulez vos paiements mensuels de prêt. Modifiez le montant, le taux et la durée pour voir l\'impact.',
        link: 'https://www.calculatorsoup.com/calculators/financial/simple-loan-calculator.php'
    },
    {
        id: 'timer',
        icon: '⏱️',
        name: 'Minuteur & Chrono',
        description: 'Minuteur et chronomètre précis',
        info: 'Minuteur et chronomètre précis pour vos séances de travail, entraînements ou applications culinaires (Pomodoro).',
        link: 'https://www.online-stopwatch.com/'
    },
    {
        id: 'image-resizer',
        icon: '🖼️',
        name: 'Redimensionneur d\'Images',
        description: 'Redimensionnez vos images facilement',
        info: 'Redimensionnez vos images aux dimensions exactes. Supportez de nombreux formats et ajustez la qualité.',
        link: 'https://www.birme.net/'
    },
    {
        id: 'text-scrambler',
        icon: '🔀',
        name: 'Mélangeur de Texte',
        description: 'Mélangez les caractères d\'un texte',
        info: 'Mélangez les mots ou les caractères d\'un texte. Utile pour les jeux, les tests et la cryptographie simple.',
        link: 'https://www.textmechanic.com/'
    },
    {
        id: 'json-formatter',
        icon: '{}',
        name: 'Formateur JSON',
        description: 'Formatez et validez vos données JSON',
        info: 'Formatez, validez et visualisez vos données JSON. Détecte les erreurs et améliore la lisibilité du code.',
        link: 'https://jsonformatter.org/'
    },
    {
        id: 'base64-encoder',
        icon: '🔒',
        name: 'Encodeur Base64',
        description: 'Encodez et décodez en Base64',
        info: 'Encodez du texte ou des images en Base64 et décodez-les. Utile pour l\'API et la transmission de données.',
        link: 'https://www.base64encode.org/'
    },
    {
        id: 'markdown-preview',
        icon: '📄',
        name: 'Aperçu Markdown',
        description: 'Éditeur et aperçu Markdown en direct',
        info: 'Écrivez en Markdown et voyez le rendu en temps réel. Parfait pour la documentation, les blogs et les README.',
        link: 'https://dillinger.io/'
    },
    {
        id: 'qr-code-generator',
        icon: '📱',
        name: 'Générateur QR Code',
        description: 'Générez des codes QR facilement',
        info: 'Créez des codes QR pour URLs, contacts, textes et bien plus. Parfait pour partager des liens, des WiFi, des informations de contact.',
        link: 'https://www.qr-code-generator.com/'
    },
    {
        id: 'youtube-downloader',
        icon: '▶️',
        name: 'Téléchargeur YouTube',
        description: 'Téléchargez des vidéos YouTube en MP4 ou MP3',
        info: 'Téléchargez vos vidéos YouTube préférées en haute qualité. Convertissez aussi en audio MP3 pour écouter hors ligne.',
        link: 'https://y2mate.com/'
    },
    {
        id: 'remove-bg',
        icon: '✂️',
        name: 'Remove.bg',
        description: 'Supprimez le fond d\'une image automatiquement',
        info: 'Suppression automatique du fond d\'une image avec IA. Idéal pour créer des images avec fond transparent pour vos designs.',
        link: 'https://www.remove.bg/'
    },
    {
        id: 'image-compressor',
        icon: '📉',
        name: 'Compresseur d\'Images',
        description: 'Réduisez la taille de vos images sans perte de qualité',
        info: 'Compressez vos images PNG, JPG, GIF pour réduire le poids. Parfait pour optimiser vos images web et économiser l\'espace.',
        link: 'https://www.tinypng.com/'
    },
    {
        id: 'qr-url-photo',
        icon: '📸',
        name: 'QR Code depuis Photo',
        description: 'Générez un QR code à partir d\'une URL ou d\'une photo',
        info: 'Créez des QR codes personnalisés depuis une photo ou une URL. Scannable par n\'importe quel téléphone avec caméra.',
        link: 'https://www.qr-code-generator.com/'
    },
    {
        id: 'wayback-machine',
        icon: '🕐',
        name: 'Archive.org (Wayback Machine)',
        description: 'Consultez les anciennes versions d\'un site web',
        info: 'Voyagez dans le temps ! Consultez comment les sites web looked comme il y a des années. Parfait pour l\'histoire numérique et l\'archivage.',
        link: 'https://web.archive.org/'
    },
    {
        id: 'soundation',
        icon: '🎵',
        name: 'Soundation',
        description: 'Créez de la musique en ligne gratuitement',
        info: 'Éditeur musical en ligne avec instruments virtuels. Créez vos propres beats, mélodies et compositions sans installation.',
        link: 'https://soundation.com/'
    },
    {
        id: 'suno-ai',
        icon: '🤖',
        name: 'Suno AI',
        description: 'Générez de la musique avec l\'intelligence artificielle',
        info: 'Créez des chansons complètes avec IA. Donnez une description et Suno génère la musique, les paroles et l\'arrangement.',
        link: 'https://www.suno.ai/'
    }
];

function renderToolsList() {
    const grid = document.getElementById('tools-grid');
    grid.innerHTML = '';

    computerTools.forEach(tool => {
        const card = document.createElement('div');
        card.className = 'tool-card';
        card.innerHTML = `
            <div class="tool-card-icon">${tool.icon}</div>
            <h4 class="tool-card-name">${tool.name}</h4>
            <p class="tool-card-desc">${tool.description}</p>
            <button class="tool-card-btn" onclick="window.open('${tool.link}', '_blank')">
                Accéder →
            </button>
        `;
        grid.appendChild(card);
    });
}

function showServicesPage() {
    document.getElementById('landing-page').classList.remove('active');
    document.getElementById('services-page').classList.add('active');
    document.getElementById('services-list-container').style.display = 'block';
    document.getElementById('services-form-container').style.display = 'none';
    window.scrollTo(0, 0);
    renderServicesList();
}

function showToolsPage() {
    document.getElementById('landing-page').classList.remove('active');
    document.getElementById('tools-page').classList.add('active');
    window.scrollTo(0, 0);
    renderToolsList();
}

// Modal Functions
function openGamesModal() {
    document.getElementById('gamesModal').classList.add('active');
}

function closeGamesModal() {
    document.getElementById('gamesModal').classList.remove('active');
}

function openServicesModal() {
    document.getElementById('servicesModal').classList.add('active');
}

function closeServicesModal() {
    document.getElementById('servicesModal').classList.remove('active');
}

// Guidance Tooltips
function showGuidanceTooltip(message, position = 'bottom-right') {
    const tooltip = document.createElement('div');
    tooltip.className = `guidance-tooltip ${position}`;
    tooltip.innerHTML = `
        ${message}
        <button class="guidance-tooltip-close" onclick="this.parentElement.remove()">✕</button>
    `;
    document.body.appendChild(tooltip);
    setTimeout(() => tooltip.remove(), 6000);
}

// Show welcome tooltip on page load
document.addEventListener('DOMContentLoaded', function() {
    setTimeout(() => {
        showGuidanceTooltip('👋 Bienvenue ! Clique sur 🎮 ou 📱 pour découvrir mes jeux et services !', 'bottom-right');
    }, 500);

    document.getElementById('gamesModal').addEventListener('click', function(e) {
        if (e.target === this) {
            closeGamesModal();
        }
    });

    document.getElementById('servicesModal').addEventListener('click', function(e) {
        if (e.target === this) {
            closeServicesModal();
        }
    });
});

// Outils informatiques disponibles
// Liste supprimée - Les outils sont accessibles uniquement via le bouton "Découvrir nos outils gratuits"

// Game Navigation
let currentGameIndex = 0;
const totalGames = 3;

function showGame(index) {
    const cards = document.querySelectorAll('#games-container .game-card');
    cards.forEach(card => card.style.display = 'none');
    
    if (index >= totalGames) {
        currentGameIndex = 0;
    } else if (index < 0) {
        currentGameIndex = totalGames - 1;
    } else {
        currentGameIndex = index;
    }
    
    cards[currentGameIndex].style.display = 'block';
    document.getElementById('current-game').textContent = currentGameIndex + 1;
}

function nextGame() {
    showGame(currentGameIndex + 1);
}

function previousGame() {
    showGame(currentGameIndex - 1);
}

function renderServicesList() {
    const grid = document.getElementById('services-grid');
    grid.innerHTML = '';

    informaticServices.forEach(service => {
        const card = document.createElement('div');
        card.className = 'service-card';
        card.innerHTML = `
            <div class="service-card-icon">${service.icon}</div>
            <h4 class="service-card-name">${service.name}</h4>
            <p class="service-card-desc">${service.description}</p>
            <button class="service-card-btn" onclick="selectService('${service.id}', '${service.name}', '${service.icon}')">
                Choisir →
            </button>
        `;
        grid.appendChild(card);
    });
}

function selectService(serviceId, serviceName, serviceIcon) {
    selectedService = { id: serviceId, name: serviceName, icon: serviceIcon };
    
    document.getElementById('services-list-container').style.display = 'none';
    document.getElementById('services-form-container').style.display = 'block';
    
    document.getElementById('service-form-title').textContent = `${serviceIcon} ${serviceName}`;
    
    const serviceDesc = informaticServices.find(s => s.id === serviceId);
    document.getElementById('service-form-desc').textContent = serviceDesc.description;
    
    // Réinitialiser le formulaire
    document.getElementById('services-form').reset();
    document.getElementById('services-success-message').style.display = 'none';
    
    window.scrollTo(0, 300);
}

function backToServicesList() {
    document.getElementById('services-list-container').style.display = 'block';
    document.getElementById('services-form-container').style.display = 'none';
    selectedService = null;
    window.scrollTo(0, 0);
}

// Gérer la soumission du formulaire de services
document.addEventListener('DOMContentLoaded', function() {
    const servicesForm = document.getElementById('services-form');
    if (servicesForm) {
        servicesForm.addEventListener('submit', function(e) {
            e.preventDefault();
            sendServiceForm();
        });
    }
});

function sendServiceForm() {
    const prenom = document.getElementById('service-prenom').value;
    const email = document.getElementById('service-email').value;
    const phone = document.getElementById('service-phone').value;

    if (!selectedService) {
        alert('Erreur: Aucun service sélectionné');
        return;
    }

    // Préparer les données pour EmailJS avec les mêmes paramètres que le formulaire principal
    const templateParams = {
        user_name: prenom,
        user_email: email,
        user_phone: phone,
        service_type: selectedService.name,
        message: `Nouvelle demande de service informatique\n\nService: ${selectedService.name}`
    };

    // Envoyer l'email via EmailJS avec les mêmes identifiants que le formulaire principal
    emailjs.send('default_service', 'template_t8zpie8', templateParams)
        .then(function(response) {
            console.log('Email envoyé avec succès', response);
            
            // Afficher le message de succès
            document.getElementById('services-form').style.display = 'none';
            document.getElementById('services-success-message').style.display = 'block';
            document.getElementById('service-user-email').textContent = email;
        }, function(error) {
            console.error('Erreur lors de l\'envoi:', error);
            alert('❌ Erreur lors de l\'envoi du formulaire. Veuillez réessayer.');
        });
}

function renderQuestion() {
    const container = document.getElementById('question-container');
    const question = questions[currentStep];

    let html = `<div class="question-content"><h3 class="question-title">${question.title}</h3>`;

    if (question.subtitle) html += `<p class="question-subtitle">${question.subtitle}</p>`;

    if (question.type === 'choice') {
        html += `<div class="choice-grid">`;
        question.options.forEach(option => {
            const isSelected = formData[question.id] === option;
            html += `<button type="button" class="choice-btn ${isSelected ? 'selected' : ''}" onclick="selectChoice('${question.id}', '${option.replace(/'/g, "\\'")}')">  ${option}</button>`;
        });
        html += `</div>`;
        if (question.hasOther && formData[question.id] === '✨ Autre (préciser)') {
            html += `<input type="text" id="${question.otherId}" value="${formData[question.otherId] || ''}" placeholder="Précise..." class="other-input" oninput="updateFormData('${question.otherId}', this.value)">`;
        }
    }

    if (question.type === 'choice-grid') {
        html += `<div class="choice-grid-small">`;
        question.options.forEach(option => {
            const isSelected = formData[question.id] === option;
            html += `<button type="button" class="choice-btn-small ${isSelected ? 'selected' : ''}" onclick="selectChoice('${question.id}', '${option.replace(/'/g, "\\'")}')"> ${option}</button>`;
        });
        html += `</div>`;
        if (question.hasOther && formData[question.id] === '🎨 Couleurs perso') {
            html += `<input type="text" id="${question.otherId}" value="${formData[question.otherId] || ''}" placeholder="${question.otherLabel}" class="other-input" oninput="updateFormData('${question.otherId}', this.value)">`;
        }
    }

    if (question.type === 'multi-choice') {
        html += `<div class="choice-grid">`;
        question.options.forEach(option => {
            const values = formData[question.id] || [];
            const isSelected = values.includes(option);
            html += `<button type="button" class="choice-btn ${isSelected ? 'selected' : ''}" onclick="toggleMultiChoice('${question.id}', '${option.replace(/'/g, "\\'")}')"> ${option}</button>`;
        });
        html += `</div>`;
        if (question.hasText) {
            html += `<input type="text" id="${question.textId}" value="${formData[question.textId] || ''}" placeholder="${question.textPlaceholder}" class="other-input" oninput="updateFormData('${question.textId}', this.value)">`;
        }
    }

    if (question.type === 'text') {
        html += `<input type="text" id="${question.id}" value="${formData[question.id] || ''}" placeholder="${question.placeholder}" class="text-input" oninput="updateFormData('${question.id}', this.value)">`;
    }

    if (question.type === 'textarea') {
        html += `<textarea id="${question.id}" rows="5" placeholder="${question.placeholder}" class="textarea-input" oninput="updateFormData('${question.id}', this.value)">${formData[question.id] || ''}</textarea>`;
    }

    if (question.type === 'textarea-important') {
        if (question.examples) {
            html += `<div class="examples-box"><p class="examples-title">💡 Exemples :</p><ul class="examples-list">`;
            question.examples.forEach(ex => html += `<li>• "${ex}"</li>`);
            html += `</ul></div>`;
        }
        html += `<textarea id="${question.id}" rows="4" placeholder="${question.placeholder}" class="textarea-input important" oninput="updateFormData('${question.id}', this.value)">${formData[question.id] || ''}</textarea>`;
    }

    if (question.type === 'email') {
        if (question.info) html += `<div class="info-box"><p class="info-title">ℹ️ Important :</p><p class="info-text">${question.info}</p></div>`;
        html += `<input type="email" id="${question.id}" value="${formData[question.id] || ''}" placeholder="${question.placeholder}" class="text-input email" oninput="updateFormData('${question.id}', this.value)" required>`;
    }

    html += `</div>`;
    container.innerHTML = html;
    updateProgress();
    updateNavigation();
}

function selectChoice(id, value) {
    formData[id] = value;
    renderQuestion();
}

function toggleMultiChoice(id, value) {
    if (!formData[id]) formData[id] = [];
    const index = formData[id].indexOf(value);
    if (index > -1) formData[id].splice(index, 1);
    else formData[id].push(value);
    renderQuestion();
}

function updateFormData(id, value) {
    formData[id] = value;
}

function updateProgress() {
    const total = questions.length;
    const current = currentStep + 1;
    const percent = Math.round((current / total) * 100);
    document.getElementById('progress-current').textContent = `Question ${current} / ${total}`;
    document.getElementById('progress-percent').textContent = `${percent}%`;
    document.getElementById('progress-fill').style.width = `${percent}%`;
}

function updateNavigation() {
    document.getElementById('prev-btn').style.display = currentStep > 0 ? 'block' : 'none';
    if (currentStep < questions.length - 1) {
        document.getElementById('next-btn').style.display = 'block';
        document.getElementById('submit-btn').style.display = 'none';
    } else {
        document.getElementById('next-btn').style.display = 'none';
        document.getElementById('submit-btn').style.display = 'flex';
    }
}

function nextQuestion() {
    if (currentStep < questions.length - 1) {
        currentStep++;
        renderQuestion();
        window.scrollTo(0, 0);
    }
}

function previousQuestion() {
    if (currentStep > 0) {
        currentStep--;
        renderQuestion();
        window.scrollTo(0, 0);
    }
}

// ========================================
// GESTION TOUCHE ENTER SUR MOBILE
// ========================================
// Empêche l'envoi du formulaire avec Enter et passe à la question suivante
document.getElementById('site-form').addEventListener('keydown', function(e) {
    // Si Enter est pressé (code 13 ou key "Enter")
    if (e.key === 'Enter' || e.keyCode === 13) {
        // Empêche le comportement par défaut (envoi du formulaire)
        e.preventDefault();
        
        // Si on n'est pas à la dernière question, passe à la suivante
        if (currentStep < questions.length - 1) {
            nextQuestion(); // Simule un clic sur "Suivant"
        }
        // Si on est à la dernière question, ne rien faire
        // (l'utilisateur doit cliquer explicitement sur "Finaliser")
    }
});

// Soumission via EmailJS
document.getElementById('site-form').addEventListener('submit', async function(e) {
    e.preventDefault();

    const submitBtn = document.getElementById('submit-btn');
    
    console.log("📋 Soumission finale du formulaire de création...");
    
    // L'authentification Google a déjà été faite dans showFormPage()
    // Les crédits ont déjà été déduits dans showFormPage()
    
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>⏳</span><span>Envoi en cours...</span>';

    // Préparer les données pour EmailJS
    console.log("📧 Préparation de l'email...");
    const templateParams = {
        to_email: 'guizmow1031@gmail.com',
        user_email: formData.email || 'Non renseigné',
        site_type: formData.siteType || 'Non renseigné',
        project_name: formData.projectName || 'Non renseigné',
        main_goal: formData.mainGoal || 'Non renseigné',
        other_goal: formData.otherGoal || '',
        element_types: formData.elementTypes || 'Non renseigné',
        style_vibe: formData.styleVibe || 'Non renseigné',
        custom_colors: formData.customColors || '',
        page_types: formData.pageTypes ? formData.pageTypes.join(', ') : 'Non renseigné',
        other_page: formData.otherPage || '',
        content_to_show: formData.contentToShow || 'Non renseigné',
        additional_info: formData.additionalInfo || 'Non renseigné',
        site_purpose: formData.sitePurpose ? formData.sitePurpose.join(', ') : 'Non renseigné',
        other_purpose: formData.otherPurpose || '',
        site_style: formData.siteStyle || 'Non renseigné',
        custom_style: formData.customStyle || '',
        similar_site: formData.similarSite || 'Non renseigné',
        magic_machine: formData.magicMachine || 'Non renseigné',
        vision_phrase: formData.visionPhrase || 'Non renseigné'
    };

    // Envoyer via EmailJS
    console.log("📤 Envoi de l'email...");
    emailjs.send('default_service', 'template_t8zpie8', templateParams)
        .then(function(response) {
            console.log('✅ Email envoyé avec succès!', response.status, response.text);
            
            document.querySelector('.site-form').style.display = 'none';
            document.querySelector('.progress-container').style.display = 'none';
            document.getElementById('user-email').textContent = formData.email;
            document.getElementById('success-message').classList.add('show');
            
            // Afficher un message sur les crédits restants
            const creditsLeft = getCredits();
            console.log(`💎 Crédits restants: ${creditsLeft}`);
            showGuidanceTooltip(`✨ Site créé avec succès ! Il vous reste ${creditsLeft} crédits.`, 'bottom-left');
            
        }, function(error) {
            console.error('❌ Erreur envoi email:', error);
            alert('❌ Une erreur est survenue lors de l\'envoi. Veuillez réessayer.');
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<span>✨</span><span>Finaliser et envoyer</span><span>🚀</span>';
        });
});

// Génération étoiles
function generateStars() {
    const container = document.getElementById('stars-container');
    if (!container) return;
    for (let i = 0; i < 200; i++) {
        const star = document.createElement('div');
        star.className = 'star';
        star.style.width = (Math.random() * 2 + 0.5) + 'px';
        star.style.height = star.style.width;
        star.style.top = (Math.random() * 100) + '%';
        star.style.left = (Math.random() * 100) + '%';
        star.style.opacity = Math.random() * 0.8 + 0.2;
        container.appendChild(star);
    }
}

function generateTwinkleStars() {
    const container = document.getElementById('twinkle-stars-container');
    if (!container) return;
    for (let i = 0; i < 100; i++) {
        const star = document.createElement('div');
        star.className = 'twinkle-star';
        star.style.width = (Math.random() * 3 + 1) + 'px';
        star.style.height = star.style.width;
        star.style.top = (Math.random() * 100) + '%';
        star.style.left = (Math.random() * 100) + '%';
        star.style.animationDelay = (Math.random() * 5) + 's';
        star.style.animationDuration = (Math.random() * 3 + 2) + 's';
        star.style.opacity = Math.random() * 0.9 + 0.3;
        container.appendChild(star);
    }
}

function generateBrightStars() {
    const container = document.getElementById('bright-stars-container');
    if (!container) return;
    const colors = ['#a78bfa', '#c084fc', '#e879f9', '#60a5fa', '#38bdf8'];
    for (let i = 0; i < 30; i++) {
        const star = document.createElement('div');
        star.className = 'bright-star';
        star.style.top = (Math.random() * 100) + '%';
        star.style.left = (Math.random() * 100) + '%';
        const color = colors[Math.floor(Math.random() * colors.length)];
        star.style.background = 'radial-gradient(circle, ' + color + ' 0%, transparent 70%)';
        star.style.animationDelay = (Math.random() * 4) + 's';
        star.style.animationDuration = (Math.random() * 2 + 3) + 's';
        container.appendChild(star);
    }
}

function generateShootingStars() {
    const container = document.getElementById('shooting-stars-container');
    if (!container) return;
    for (let i = 0; i < 8; i++) {
        const shootingStar = document.createElement('div');
        shootingStar.className = 'shooting-star';
        shootingStar.style.top = (Math.random() * 50) + '%';
        shootingStar.style.left = (Math.random() * 100) + '%';
        shootingStar.style.animationDuration = (Math.random() * 3 + 4) + 's';
        shootingStar.style.animationDelay = (Math.random() * 8) + 's';
        const core = document.createElement('div');
        core.className = 'shooting-star-core';
        const trail = document.createElement('div');
        trail.className = 'shooting-star-trail';
        shootingStar.appendChild(core);
        shootingStar.appendChild(trail);
        container.appendChild(shootingStar);
    }
}

function generateParticles() {
    const container = document.getElementById('particles-container');
    if (!container) return;
    const colors = ['rgba(168,85,247,0.6)', 'rgba(99,102,241,0.6)', 'rgba(236,72,153,0.6)', 'rgba(59,130,246,0.6)'];
    for (let i = 0; i < 40; i++) {
        const particle = document.createElement('div');
        particle.className = 'particle';
        particle.style.width = (Math.random() * 6 + 2) + 'px';
        particle.style.height = particle.style.width;
        particle.style.top = (Math.random() * 100) + '%';
        particle.style.left = (Math.random() * 100) + '%';
        const color = colors[Math.floor(Math.random() * colors.length)];
        particle.style.background = 'radial-gradient(circle, ' + color + ' 0%, transparent 70%)';
        particle.style.animationDuration = (Math.random() * 20 + 15) + 's';
        particle.style.animationDelay = (Math.random() * 10) + 's';
        container.appendChild(particle);
    }
}

// ========================================
// FORMULAIRE DE MODIFICATION DE SITE (FormSubmit)
// ========================================

function setupModificationForm() {
    const form = document.getElementById('modification-form');
    if (!form) return;

    form.addEventListener('submit', async (event) => {
        event.preventDefault();

        if (form.dataset.locked === 'true') {
            return;
        }

        form.dataset.locked = 'true';

        const modificationTextarea = document.getElementById('modification-request');
        const modificationText = modificationTextarea ? modificationTextarea.value.trim() : '';

        if (!modificationText) {
            alert('❌ Veuillez décrire les modifications que vous souhaitez apporter.');
            form.dataset.locked = 'false';
            return;
        }

        const currentCredits = getCredits();
        if (currentCredits < 10) {
            alert('❌ CRÉDITS INSUFFISANTS !\n\n' +
                  'Il vous faut 10 crédits pour modifier un site.\n' +
                  'Vous avez actuellement : ' + currentCredits + ' crédit(s).\n\n' +
                  '💡 Contactez-nous pour obtenir plus de crédits !');
            form.dataset.locked = 'false';
            return;
        }

        try {
            const authResult = await ensureGoogleAuth();
            if (authResult === null) return;
        } catch (error) {
            console.error('❌ Erreur authentification:', error);
            alert('❌ Connexion Google requise pour envoyer la demande.');
            form.dataset.locked = 'false';
            return;
        }

        const success = await deductCredits(10);
        if (!success) {
            alert('❌ Erreur lors de la déduction des crédits.');
            form.dataset.locked = 'false';
            return;
        }

        form.submit();
    });
}

window.addEventListener('load', function() {
    // Générer les effets visuels
    generateStars();
    generateTwinkleStars();
    generateBrightStars();
    generateShootingStars();
    generateParticles();

    // Initialiser les boutons d'auth
    setupAuthButtons();
    setupAuthGateForClicks();

    // Bouton paiement Starter
    const starterBtn = document.getElementById('starter-plan-btn');
    if (starterBtn) {
        starterBtn.addEventListener('click', startStarterCheckout);
    }

    const navAddCreditsBtn = document.getElementById('nav-add-credits');
    if (navAddCreditsBtn) {
        navAddCreditsBtn.addEventListener('click', async () => {
            await addCreditsAndHide(navAddCreditsBtn);
        });
    }

    setupStarterForm();
    setupModificationForm();

    const resetCreditsBtn = document.getElementById('reset-credits-logout');
    if (resetCreditsBtn) {
        resetCreditsBtn.addEventListener('click', async () => {
            if (resetCreditsBtn.dataset.locked === 'true') {
                return;
            }

            const confirmed = confirm('Remettre les crédits à 10 et se déconnecter ?');
            if (!confirmed) return;

            resetCreditsBtn.dataset.locked = 'true';

            try {
                const updated = await setCredits(10);
                if (!updated) {
                    alert('❌ Erreur lors de la remise à 10 crédits.');
                    resetCreditsBtn.dataset.locked = 'false';
                    return;
                }

                await signOut(auth);
                alert('✅ Crédits remis à 10 et déconnexion effectuée.');
            } catch (error) {
                console.error('❌ Erreur reset crédits:', error);
                alert('❌ Erreur lors de la déconnexion.');
                resetCreditsBtn.dataset.locked = 'false';
            }
        });
    }

    // Double-clic admin désactivé
    
    console.log('✅ Site chargé - En attente de l\'authentification Firebase...');
});

// Bouton temporaire de déconnexion (debug)
window.addEventListener('load', function() {
    const logoutBtn = document.getElementById('logout-temp');
    if (!logoutBtn) return;
    logoutBtn.addEventListener('click', async () => {
        try {
            await signOut(auth);
            console.log('✅ Déconnexion effectuée');
            alert('✅ Déconnecté. Rechargez la page pour repasser en anonyme.');
        } catch (error) {
            console.error('❌ Erreur déconnexion:', error);
            alert('❌ Erreur lors de la déconnexion.');
        }
    });
});