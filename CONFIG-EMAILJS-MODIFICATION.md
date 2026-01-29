# Configuration EmailJS pour les Modifications de Site

## 📧 Créer le template pour les modifications

1. Allez sur https://dashboard.emailjs.com/
2. Connectez-vous avec votre compte
3. Sélectionnez votre service (default_service)
4. Cliquez sur **"Email Templates"**
5. Cliquez sur **"Create New Template"**

## 📝 Configuration du template

### **Template ID** : `template_modification`

### **Subject** : 
```
🔧 Demande de modification de site - {{user_email}}
```

### **Content** :
```html
<h2>🔧 Demande de modification de site</h2>

<p><strong>De :</strong> {{user_email}}</p>
<p><strong>UID Utilisateur :</strong> {{user_uid}}</p>

<h3>📝 Modifications demandées :</h3>
<div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 20px 0;">
    {{modification_request}}
</div>

<hr>

<p><em>Cette demande a été envoyée automatiquement depuis votre site web.</em></p>
<p><em>L'utilisateur a dépensé 10 crédits pour cette modification.</em></p>
```

## ✅ Variables utilisées

- `{{user_email}}` - Email de l'utilisateur connecté
- `{{user_uid}}` - UID Firebase de l'utilisateur
- `{{modification_request}}` - Texte de la demande de modification

## 🎯 Une fois créé

Votre système de modification est prêt ! Quand un utilisateur clique sur "Demander une modification", voici ce qui se passe :

1. ✅ Vérification des crédits (10 minimum)
2. 🔐 Popup Google s'ouvre (authentification)
3. 📧 Email envoyé à guizmow1031@gmail.com
4. 💳 10 crédits déduits
5. ✅ Message de confirmation

## 🧪 Test

1. Ouvrez votre site
2. Faites défiler jusqu'à "Modifie ton site web"
3. Entrez une description de modification
4. Cliquez sur "Demander une modification"
5. La popup Google s'ouvre → Connectez-vous
6. Email envoyé + 10 crédits déduits ✅
