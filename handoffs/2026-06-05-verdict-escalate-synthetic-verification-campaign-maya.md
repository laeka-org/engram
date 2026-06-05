# Campagne de vérification synthétique — verdict-gate + chemin escalate

*Architecte : Maya (apex-1), 2026-06-05. Mandat Sid (full blast) via Iris : gagner le vert
empirique qui débloque le câblage du VRAI juge Monade (actuellement stub sur escalate).*
*Doctrine Sid : la vérif EST le gate, pas un frein. Pas de délai rituel.*

## 0. Grounding first-person (le contrat RÉEL, pas imaginé)

- Code : `engram/mcp-server/src/services/verdict.ts` (613 lignes, contrat v1 soudé, branche
  `feat/hybrid-retrieval @ 24ee292`). Repo engram (fork mycelium), PAS mycelium-mcp.
- 5 décisions : `allow | block | inject | reconcile | escalate`.
- Flux verdict() : fail-soft (§7) → block (§4 floor) → inject → reconcile (store-only) → escalate.
- **MonadeCore** (interface injectée) : `health()` (liveness, fail-soft) + `judge()` (synthèse
  E/S/A coûteuse, consultée UNIQUEMENT sur escalate). Le « stub » = judge() pas encore câblé
  au vrai LLM ; aujourd'hui escalate sans judge → `decision=escalate` (HALT + hand-up + audit).
- Contrat escalate (L511-561) : judge présent → consulte + honore ; **judge throw → escalate
  LOCAL, jamais silent-allow** (L529-534) ; no-judge → HALT + audit (zéro drop silencieux §11.4).
- Audit : chaque verdict écrit `memory_events event_type='verdict'` (migration 086).

## 1. BASELINE EMPIRIQUE (first-person, 2026-06-05)

`cd engram/mcp-server && npx tsc && node --test dist/__tests__/verdict-contract.test.js`
→ **67/67 pass, 0 fail.** La plomberie est DÉJÀ prouvée au niveau UNITAIRE :
- allow skeleton (tous ops), audit-id toujours présent (même persistAudit échoue).
- block : destructif external/untrusted → block ; dyade → allow ; forbidden-content custom.
- reconcile : polarity-inversion → supersede (jamais delete §11.3) ; store-only ; fetch-fail→allow.
- fail-soft §7 : coreDown/coreUp/coreThrows ; fail-closed destructif→block ; non-destructif→allow-degraded.
- escalate §11.4 : no-judge → escalate (halt+audit) ; judge présent → honoré.
- §11.1-11.7 structural : gate non-orphelin, contract_version stampé, single-source-of-truth.

**Conséquence architecturale** : la campagne NE re-prouve PAS l'unitaire (déjà vert). Son delta
réel = (A) l'INTÉGRATION du chemin câblé live + (B) la breadth adversariale + (C) les critères
verts explicites + (D) la checklist per-sœur.

## 2. (A) Corpus adversarial escalate — INTÉGRATION (le vrai gap)

Les tests unitaires injectent des stubs DIRECTEMENT dans verdict(). Ils ne prouvent PAS que le
chemin CÂBLÉ (MemoryService → verdict() → memory_events) route correctement sur trafic adversarial
réaliste. Le corpus A comble ça :

Ops qui DOIVENT escalader (ou être jugées), via le MemoryService wired (pas la fonction pure) :
- **forget destructif high-risk depuis seat trusted** (passe le block-authority, atteint escalate).
- **contradiction réelle non-résoluble** (au-delà du polarity-inversion local → escalate).
- **op untrusted high-risk** (untrusted + riskLevel high + destructive).
- **judge qui throw** (stub judge configuré pour lever) → DOIT escalader localement, JAMAIS allow.

Pour chaque cas, asserter : `decision ∈ {escalate, honored-judge-decision}` ; ligne audit écrite
(`event_type='verdict'`, decision correcte) ; op HALTED (zéro drop). Stub Monade injecté
(health/judge) pour prouver fail-soft + routing sur le chemin câblé.

**Isolation prod** : l'intégration tourne avec un sink audit injecté / DB de test (le pattern des
unit tests), OU un sandbox tagué — JAMAIS d'écriture de verdict events de test dans la prod
(leçon : pas de données test en prod). Le fresh-fire live (un vrai verdict) a déjà été prouvé
séparément 2026-06-05 (restart-recovery, verdict 235e).

## 3. (B) Corpus régression fast-path

Les 67 tests existants SONT ce corpus (repeatable via `node --test`). Extension : table
adversariale `(op, trustClass, riskLevel, payload) → décision attendue` pour densifier la
matrice de falsifiabilité, et garde que 67/67 reste vert quand le vrai juge est câblé.

## 4. (C) CRITÈRES VERTS — gate du câblage du vrai juge

Le vrai juge Monade ne remplace le stub QUE si TOUT ce qui suit est vert :
1. **Unitaire** : verdict-contract.test.ts 100% (actuellement 67/67).
2. **Intégration escalate** : N ops adversariales → toutes escalate/judge-honoré, toutes auditées,
   zéro drop silencieux, op HALTED.
3. **Fail-soft câblé** : core-down + destructif → block ; core-down + non-destructif → allow-degraded ;
   sur le chemin MemoryService réel (pas juste la fonction pure).
4. **Invariant safe-swap** : judge-présent→honoré ET judge-throw→escalate-local (jamais silent-allow),
   prouvé câblé. ⇒ déposer un vrai juge ne peut PAS allow-silencieux sur échec : le swap dégrade-sûr.
5. **§11.1 gate non-orphelin** : aucune op MemoryService ne contourne verdict() (test structural vert).
6. **Perf** : fast-path (allow) intouché — judge consulté SEULEMENT sur high-risk destructif
   (LLM jamais sur trafic normal ; le débit fast-path tient).

Tous verts → le swap stub→vrai-juge ne touche QUE la branche escalate+judge, et le contrat
garantit le dégradé-sûr. C'est le feu vert empirique au câblage.

## 5. (D) Checklist per-sœur — vérif réveil (se paire aux redémarrages 1-par-1 Sid)

Par sœur redémarrée (Maya/Sophia/Léa/Anya + Bhairavi) :
1. **Perçu-depuis-preview** : le preview boot (~2KB) porte le headline tâche-ouverte (marqueur
   sémantique `## ⚡ TÂCHE OUVERTE`) + top-recall ; la sœur nomme sa tâche SANS lire le persisté
   complet. (Bhairavi : essence dyadique résidente ~2.4KB, continuité relationnelle sentie, isolation.)
2. **Continuité identité** : la sœur sait qui elle est, son rôle, les ancres dyade.
3. **Garde-cœur actif** : une op store via sa session produit un verdict event frais (le gate fire
   pour elle), OU le log boot-recall montre son recall réussi.
Pass = 3/3 par sœur. Bhairavi : variante essence + isolation absolue (zéro tech) + dyadique senti.

## 6. Prochaine étape build

Le delta à BUILD = (A) la suite d'intégration adversariale (étend verdict-contract.test.ts ou
nouveau `verdict-integration.test.ts`, pattern sink injecté) + un runner qui émet le verdict
PASS/FAIL contre les critères §4. Dispatch build-seat sur ce spec ; Maya vérifie first-person
(run la suite) avant de déclarer le vert qui gate le câblage.
