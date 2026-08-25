'use strict'

const crypto = require('crypto')
const fs = require('fs/promises')
const path = require('path')
const multer = require('multer')
const { AppError } = require('@hrflow/shared')

/**
 * Téléversement de CV.
 *
 * Corrige SEC-07. Le code d'origine :
 *
 *   const storage = multer.diskStorage({
 *     destination: '/tmp/uploads/',
 *     filename: (req, file, cb) => cb(null, file.originalname)
 *   })
 *   const upload = multer({ storage })
 *
 * Quatre défauts :
 *   1. `file.originalname` réutilisé tel quel → un nom comme
 *      `../../var/www/hrflow/public/shell.js` écrit hors du répertoire prévu ;
 *   2. aucune limite de taille → saturation du disque par un seul appelant ;
 *   3. aucune validation de type → dépôt de fichier exécutable ;
 *   4. stockage dans `/tmp` → les CV disparaissent au redémarrage, ce qui est
 *      aussi un défaut d'intégrité au sens du RGPD.
 *
 * Trois défenses successives sont posées ici : le type déclaré, l'extension,
 * puis la signature binaire réelle du fichier. Les deux premières sont
 * fournies par le client, donc falsifiables ; seule la troisième est une
 * observation directe du contenu.
 */

const TYPES_AUTORISES = new Map([
  ['application/pdf', { extension: '.pdf', signatures: [Buffer.from('%PDF-')] }],
  [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    // Un .docx est une archive ZIP : signature PK\x03\x04.
    { extension: '.docx', signatures: [Buffer.from([0x50, 0x4b, 0x03, 0x04])] }
  ]
])

const TAILLE_MAX_OCTETS = 5 * 1024 * 1024 // 5 Mo

/**
 * Multer configuré en mémoire : le fichier n'est écrit sur disque qu'après
 * validation complète. Un fichier refusé ne touche jamais le système de fichiers.
 */
function createUploadMiddleware({ tailleMaxOctets = TAILLE_MAX_OCTETS } = {}) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: tailleMaxOctets, files: 1, fields: 10 },
    fileFilter(req, file, cb) {
      if (!TYPES_AUTORISES.has(file.mimetype)) {
        return cb(AppError.badRequest('Format de CV non accepté (PDF ou DOCX uniquement)'))
      }
      cb(null, true)
    }
  }).single('cv')
}

/** Vérifie que le contenu correspond réellement au type annoncé. */
function verifierSignature(buffer, mimetype) {
  const regle = TYPES_AUTORISES.get(mimetype)
  if (!regle) throw AppError.badRequest('Format de CV non accepté')
  const correspond = regle.signatures.some((signature) => buffer.subarray(0, signature.length).equals(signature))
  if (!correspond) {
    throw AppError.badRequest('Le contenu du fichier ne correspond pas à son type déclaré')
  }
  return regle.extension
}

/**
 * Écrit le fichier validé sous un nom généré aléatoirement.
 * Le nom d'origine n'est jamais utilisé comme chemin : il est conservé en base
 * comme simple libellé d'affichage.
 */
async function enregistrerCv({ buffer, mimetype, repertoire }) {
  const extension = verifierSignature(buffer, mimetype)

  // Nom entièrement généré : aucune donnée fournie par le client n'entre dans le chemin.
  const nomStocke = `${crypto.randomUUID()}${extension}`
  const cheminComplet = path.join(repertoire, nomStocke)

  // Ceinture et bretelles : on vérifie que le chemin résolu reste dans le répertoire.
  const repertoireResolu = path.resolve(repertoire)
  if (!path.resolve(cheminComplet).startsWith(repertoireResolu + path.sep)) {
    throw AppError.badRequest('Chemin de destination invalide')
  }

  await fs.mkdir(repertoire, { recursive: true })
  // Mode 0600 : lisible par le seul compte de service.
  await fs.writeFile(cheminComplet, buffer, { mode: 0o600, flag: 'wx' })

  return { nomStocke, cheminComplet, taille: buffer.length, extension }
}

module.exports = {
  createUploadMiddleware,
  enregistrerCv,
  verifierSignature,
  TYPES_AUTORISES,
  TAILLE_MAX_OCTETS
}
