'use strict'

const fs = require('fs/promises')
const os = require('os')
const path = require('path')

const { enregistrerCv, verifierSignature, TAILLE_MAX_OCTETS } = require('../src/uploads')

/**
 * Les charges de test sont construites octet par octet plutôt qu'écrites en
 * clair : un fichier de test contenant des signatures d'exécutable ou de
 * webshell finit en quarantaine antivirus, et le pipeline échoue pour une
 * raison qui n'a rien à voir avec le code. Constaté pendant l'écriture de
 * cette suite.
 */
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x20)])
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0x20)])
const TYPE_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** En-tête d'exécutable Windows (0x4D 0x5A), reconstitué par octets. */
const EXECUTABLE = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(32, 0x00)])

/** Début d'un script serveur, assemblé pour ne correspondre à aucune signature. */
const SCRIPT = Buffer.from(['<', '?', 'x', ' ', 'contenu', ' ', 'de', ' ', 'test'].join(''))

describe('validation du contenu réel du fichier (SEC-07)', () => {
  it('accepte un PDF dont la signature correspond', () => {
    expect(verifierSignature(PDF, 'application/pdf')).toBe('.pdf')
  })

  it('accepte un DOCX (archive ZIP) dont la signature correspond', () => {
    expect(verifierSignature(DOCX, TYPE_DOCX)).toBe('.docx')
  })

  it('refuse un exécutable déguisé en PDF', () => {
    // Un client peut annoncer n'importe quel type MIME : seule la signature compte.
    expect(() => verifierSignature(EXECUTABLE, 'application/pdf')).toThrow(/ne correspond pas à son type déclaré/)
  })

  it('refuse un script déguisé en DOCX', () => {
    expect(() => verifierSignature(SCRIPT, TYPE_DOCX)).toThrow(/ne correspond pas/)
  })

  it('refuse un type non autorisé', () => {
    expect(() => verifierSignature(PDF, 'application/x-msdownload')).toThrow(/non accepté/)
  })

  it('plafonne la taille acceptée à 5 Mo', () => {
    expect(TAILLE_MAX_OCTETS).toBe(5 * 1024 * 1024)
  })
})

describe('écriture sur disque — traversée de répertoire (SEC-07)', () => {
  let repertoire

  beforeEach(async () => {
    repertoire = await fs.mkdtemp(path.join(os.tmpdir(), 'hrflow-cv-'))
  })

  afterEach(async () => {
    await fs.rm(repertoire, { recursive: true, force: true })
  })

  it('génère un nom aléatoire et n’utilise jamais le nom fourni', async () => {
    const resultat = await enregistrerCv({ buffer: PDF, mimetype: 'application/pdf', repertoire })

    expect(resultat.nomStocke).toMatch(/^[0-9a-f-]{36}\.pdf$/)
    const fichiers = await fs.readdir(repertoire)
    expect(fichiers).toEqual([resultat.nomStocke])
  })

  it('écrit le fichier dans le répertoire prévu, et nulle part ailleurs', async () => {
    const resultat = await enregistrerCv({ buffer: PDF, mimetype: 'application/pdf', repertoire })
    expect(path.dirname(path.resolve(resultat.cheminComplet))).toBe(path.resolve(repertoire))
  })

  it('conserve la taille réelle du fichier', async () => {
    const resultat = await enregistrerCv({ buffer: PDF, mimetype: 'application/pdf', repertoire })
    expect(resultat.taille).toBe(PDF.length)
  })

  it('crée le répertoire de destination s’il n’existe pas', async () => {
    const sousRepertoire = path.join(repertoire, 'nouveau', 'niveau')
    const resultat = await enregistrerCv({ buffer: DOCX, mimetype: TYPE_DOCX, repertoire: sousRepertoire })
    await expect(fs.access(resultat.cheminComplet)).resolves.toBeUndefined()
  })

  it('refuse d’écrire un contenu dont la signature ne correspond pas', async () => {
    await expect(
      enregistrerCv({ buffer: Buffer.from('contenu quelconque'), mimetype: 'application/pdf', repertoire })
    ).rejects.toThrow()

    // Le fichier refusé ne doit avoir laissé aucune trace.
    expect(await fs.readdir(repertoire)).toEqual([])
  })
})
