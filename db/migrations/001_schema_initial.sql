-- =============================================================================
-- Schéma initial HRFlow
--
-- Le schéma n'était documenté nulle part : le fichier docs/architecture.md
-- indiquait « PostgreSQL. Voir Théo pour le schéma » (DOC-03). Théo est parti
-- le 26 août 2024.
--
-- Choix structurant : chaque table métier porte une colonne `company_id` et un
-- index qui la précède. C'est le support du cloisonnement multi-locataire
-- (SEC-08) : sans elle, aucun filtrage applicatif n'est possible de façon fiable.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Clients de la plateforme
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
    id          BIGSERIAL PRIMARY KEY,
    nom         VARCHAR(200) NOT NULL,
    siret       VARCHAR(14),
    actif       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- Salariés
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employees (
    id                   BIGSERIAL PRIMARY KEY,
    company_id           BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    matricule            VARCHAR(50) NOT NULL,
    nom                  VARCHAR(100) NOT NULL,
    prenom               VARCHAR(100) NOT NULL,
    email                VARCHAR(254) NOT NULL,
    salaire_mensuel_brut NUMERIC(10, 2) NOT NULL CHECK (salaire_mensuel_brut >= 0),
    taux_activite        NUMERIC(3, 2) NOT NULL DEFAULT 1.00 CHECK (taux_activite > 0 AND taux_activite <= 1),
    jours_conges_acquis  INTEGER NOT NULL DEFAULT 25 CHECK (jours_conges_acquis >= 0),
    date_entree          DATE NOT NULL,
    date_sortie          DATE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT employees_matricule_unique UNIQUE (company_id, matricule),
    CONSTRAINT employees_dates_coherentes CHECK (date_sortie IS NULL OR date_sortie >= date_entree)
);

CREATE INDEX IF NOT EXISTS idx_employees_company ON employees (company_id);

-- -----------------------------------------------------------------------------
-- Comptes utilisateurs
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id              BIGSERIAL PRIMARY KEY,
    company_id      BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    employee_id     BIGINT REFERENCES employees(id) ON DELETE SET NULL,
    email           VARCHAR(254) NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    role            VARCHAR(30) NOT NULL CHECK (role IN ('salarie', 'manager', 'rh', 'recruteur', 'admin')),
    -- Compteurs de la protection contre la force brute (SEC-13), absente du
    -- système audité.
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    TIMESTAMPTZ,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE INDEX IF NOT EXISTS idx_users_company ON users (company_id);

-- -----------------------------------------------------------------------------
-- Jetons de renouvellement — support de la révocation (SEC-21)
--
-- Le système audité émettait des jetons valables 24 h, sans aucun moyen de les
-- invalider : un jeton volé restait utilisable une journée entière.
-- Les jetons sont stockés hachés : une fuite de cette table ne permet pas
-- d'usurper une session.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
    token_hash  CHAR(64) PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- -----------------------------------------------------------------------------
-- Réinitialisation de mot de passe (SEC-03)
--
-- Cette table n'existait pas : la route de réinitialisation changeait
-- directement le mot de passe de n'importe quelle adresse fournie.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_resets (
    token_hash  CHAR(64) PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets (user_id);

-- -----------------------------------------------------------------------------
-- Congés
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conges (
    id           BIGSERIAL PRIMARY KEY,
    company_id   BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    employee_id  BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    date_debut   DATE NOT NULL,
    date_fin     DATE NOT NULL,
    nombre_jours INTEGER NOT NULL,
    motif        VARCHAR(500),
    statut       VARCHAR(20) NOT NULL DEFAULT 'en_attente'
                 CHECK (statut IN ('en_attente', 'approuve', 'refuse', 'annule')),
    decided_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    decided_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Contrainte qui rend la fraude impossible au niveau de la base, même si
    -- une future version du code oubliait le contrôle applicatif (QUA-05) :
    -- des dates inversées produisaient un nombre de jours négatif, qui venait
    -- augmenter le solde du salarié.
    CONSTRAINT conges_periode_coherente CHECK (date_fin >= date_debut),
    CONSTRAINT conges_jours_positifs CHECK (nombre_jours > 0)
);

CREATE INDEX IF NOT EXISTS idx_conges_company_employee ON conges (company_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_conges_periode ON conges (employee_id, date_debut, date_fin)
    WHERE statut IN ('en_attente', 'approuve');

-- -----------------------------------------------------------------------------
-- Bulletins de paie
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bulletins_paie (
    id                 BIGSERIAL PRIMARY KEY,
    company_id         BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    employee_id        BIGINT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    mois               SMALLINT NOT NULL CHECK (mois BETWEEN 1 AND 12),
    annee              SMALLINT NOT NULL CHECK (annee BETWEEN 2000 AND 2100),
    periode_reference  VARCHAR(7) NOT NULL,
    data               JSONB NOT NULL,
    statut             VARCHAR(30) NOT NULL DEFAULT 'en_attente_paiement'
                       CHECK (statut IN ('en_attente_paiement', 'paye', 'paiement_a_rejouer', 'paiement_en_echec')),
    reference_paiement VARCHAR(100),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ,

    -- Garantie d'unicité au niveau de la base : un salarié ne peut pas avoir
    -- deux bulletins pour le même mois, donc pas deux virements (QUA-03).
    CONSTRAINT bulletins_periode_unique UNIQUE (employee_id, mois, annee)
);

CREATE INDEX IF NOT EXISTS idx_bulletins_company ON bulletins_paie (company_id);
CREATE INDEX IF NOT EXISTS idx_bulletins_a_rejouer ON bulletins_paie (statut)
    WHERE statut IN ('paiement_a_rejouer', 'paiement_en_echec');

-- -----------------------------------------------------------------------------
-- Candidatures
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS candidats (
    id             BIGSERIAL PRIMARY KEY,
    company_id     BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    nom            VARCHAR(100) NOT NULL,
    prenom         VARCHAR(100) NOT NULL,
    email          VARCHAR(254) NOT NULL,
    poste          VARCHAR(150) NOT NULL,
    -- Nom généré côté serveur. Le nom fourni par le déposant est conservé
    -- séparément, comme simple libellé : il n'entre jamais dans un chemin (SEC-07).
    cv_nom_stocke  VARCHAR(100) NOT NULL,
    cv_nom_origine VARCHAR(255),
    cv_taille      INTEGER,
    statut         VARCHAR(20) NOT NULL DEFAULT 'recu'
                   CHECK (statut IN ('recu', 'en_cours', 'entretien', 'accepte', 'refuse')),
    updated_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ,
    -- Échéance de purge : le RGPD impose une durée de conservation limitée des
    -- candidatures. Aucune politique de rétention n'existait (DOC-06).
    purge_prevue_le DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '2 years')
);

CREATE INDEX IF NOT EXISTS idx_candidats_company ON candidats (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_candidats_purge ON candidats (purge_prevue_le);
