# Audit Tessel — 25 septembre 2026

Revue Codex sur le commit **e1d524a**, en parallèle avec Claude. Périmètre : thèmes, réglages, accessibilité, rendu Classic/Warp et canal d'équipe. Aucun fichier de production ni terminal réel modifié.

**Six constats reproductibles : un P1, quatre P2, un P3.** La suite existante passe (247 tests), ainsi que le build ; les reproductions ci-dessous couvrent des comportements absents de ces vérifications.

## 1. P1 — Le CSS compilé absorbe le thème Warp dans une règle inachevée

**Emplacement :** `src/renderer/src/style.css:5234`, bloc `.pane-stuck.alert`.

L'accolade fermante manque après `color: var(--danger)`. Le navigateur interprète les règles suivantes comme du CSS imbriqué. Dans le build, la concaténation inclut également tout `themes.css` dans ce bloc.

**Reproduction :** construire le commit puis choisir Warp dans le vrai renderer isolé. L'attribut racine vaut bien `data-theme="warp"`, mais `--chrome` reste `#101216` et `.statusbar` vaut `display: block`. L'inspection du CSSOM place les règles Warp sous `.pane-stuck.alert`. Le terminal change de palette, tandis que l'interface conserve les couleurs Classic et une barre d'état mal disposée.

**Contrôle de la cause :** en ajoutant uniquement l'accolade à la réponse CSS du serveur de test, `--chrome` devient `#161917`, `.statusbar` devient `flex` et les 220 règles Warp sont à nouveau au niveau attendu. Aucune source n'a été changée pour ce contrôle.

**Correction proposée :** fermer le bloc et vérifier le rendu du build avec le test de thème existant ; le simple succès de compilation ne détecte pas cette erreur.

## 2. P2 — Le clavier peut atteindre un terminal derrière Settings

**Emplacement :** `src/renderer/src/components/SettingsDialog.vue:67`.

La fenêtre reçoit le focus à l'ouverture, mais ne le retient pas. Après le bouton Reset, Tab passe à la barre d'outils, à la barre latérale puis au champ xterm, alors que Settings reste affiché.

**Reproduction :** ouvrir Settings, parcourir ses contrôles avec Tab, continuer jusqu'au terminal et saisir `AUDIT_ONLY`. Le backend simulé reçoit dix appels `writePty`, dans les deux thèmes. Les boutons du fond deviennent également accessibles au clavier.

**Correction proposée :** confiner Tab/Shift+Tab dans le dialogue, rendre le fond inerte tant qu'il est ouvert, définir `aria-modal` et restituer le focus à la fermeture. Vérifier également les raccourcis globaux susceptibles d'agir derrière un dialogue.

## 3. P2 — Restart laisse les messages en attente sur l'ancien panneau

**Emplacements :** `src/renderer/src/App.vue:1559` et `src/main/teamChannel.js:101`, `:254`.

`restartLeaf` conserve le numéro visible, l'équipe, le rôle de lead et les tâches, mais crée un nouvel identifiant de panneau. La synchronisation du canal désactive l'ancien membre sans transférer ses messages.

**Reproduction :** envoyer un message à `pane-b`, laisser le message en attente, puis synchroniser son remplaçant `pane-b-restarted` avec le même numéro et la même équipe. Le message reste `pending` sur disque avec `toId: pane-b`, mais les livraisons retournées sont vides. Le nouveau panneau ne peut pas le lire.

**Correction proposée :** maintenir une identité logique stable ou migrer explicitement le canal lors d'un remplacement de panneau. Éviter une migration implicite fondée uniquement sur la réutilisation d'un numéro.

## 4. P2 — Le plafond de 200 livraisons masque des messages aux autres agents

**Emplacements :** `src/main/teamChannel.js:258` et `src/renderer/src/App.vue:3487`.

La liste des livraisons est limitée aux 200 premières entrées. Le renderer utilise cette liste tronquée pour calculer les messages non lus et déclencher les réveils du canal en arrière-plan.

**Reproduction :** placer 200 accusés de réception en attente pour A, puis un vrai message pour C. Le disque contient 201 entrées en attente ; le poll ne retourne que les 200 accusés. Le renderer les exclut des comptes et produit `teamUnread = {}`. C ne reçoit donc ni compteur ni réveil. Des messages anciens destinés à un agent qui ne lit pas peuvent aussi monopoliser cette fenêtre.

**Correction proposée :** retourner des comptes complets par destinataire indépendamment du lot de livraison, ou paginer équitablement. Les comptes doivent suivre les mêmes règles que les messages réellement lisibles.

## 5. P2 — Un nom de workspace long pousse les commandes sous les boutons Windows

**Emplacements :** `src/renderer/src/style.css:3303`, `:3334` ; taille minimale et boutons natifs dans `src/main/index.js:1243`, `:1254`.

À la largeur minimale autorisée de 640 px, la partie gauche de la barre ne peut pas se réduire suffisamment lorsque le nom du workspace est long.

**Reproduction :** renommer le workspace en `Trading research and development workspace`, puis réduire la fenêtre à 640 px. La zone réservée aux boutons Windows commence à x=490. Task board atteint x=505, Layout x=537 et Settings occupe x=539..569. Ces commandes empiètent sur l'espace de l'overlay natif.

**Limite de la mesure :** coordonnées relevées dans Chromium avec le vrai renderer et la réservation CSS de 150 px ; le navigateur de test n'affiche pas les boutons natifs Electron. Le défaut d'espace est mesuré, l'occlusion finale est déduite de la configuration de l'overlay.

**Correction proposée :** autoriser la réduction du groupe de gauche et tronquer davantage le nom aux petites largeurs, en conservant l'espace des commandes et des boutons natifs.

## 6. P3 — Plusieurs réglages n'ont pas de nom accessible

**Emplacements :** `src/renderer/src/components/SettingsDialog.vue:109`, `:161`, `:175`, `:252`.

Font, Default shell, Scrollback et Language affichent un texte voisin, sans association à leur contrôle. L'arbre d'accessibilité du navigateur retourne un nom vide pour ces quatre champs, dans les deux thèmes. La sélection du curseur est également indiquée uniquement par une classe visuelle.

**Correction proposée :** associer les labels et les champs par `for`/`id`, puis exposer la sélection du curseur avec des boutons à état ou un groupe radio.

## Vérifications et preuves

- Copie isolée du commit, build réussi et **247/247 tests** réussis.
- Vrai renderer avec PTYs simulés : 1366×768, 800×600 et 640×400 ; aucune erreur JavaScript observée dans ces parcours.
- Scripts : `C:\Tessel\design\audit-ui.cjs` et `C:\Tessel\design\audit-channel.cjs`.
- Résultats : `ui-results.json`, `styles-results.json`, `channel-results.json`, et versions `*-css-repair.json` pour le contrôle de l'accolade.
- Captures avant/après : `warp-640.png`, `warp-640-css-repair.png`, `long-workspace-640-css-repair.png`.

Les scénarios canal utilisent le vrai module sur des dossiers jetables. Les scénarios UI utilisent le code compilé du projet, des données locales isolées et un backend simulé : aucune commande n'a été envoyée aux agents de Jean-Claude.

Répartition proposée pour la correction : Codex — Settings et comptes du canal ; Claude — CSS Classic, barre supérieure et identité au redémarrage, avec raccord App.vue des comptes complets. Claude consolide ces constats avec sa propre revue avant les corrections.
