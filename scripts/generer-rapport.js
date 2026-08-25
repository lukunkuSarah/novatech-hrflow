#!/usr/bin/env node
'use strict'

const path = require('path')
const fs = require('fs')
const { chromium } = require('@playwright/test')

/**
 * Génération du rapport PDF.
 *
 * Le rapport est écrit en HTML, versionné dans le dépôt, et converti par le
 * navigateur déjà présent pour les tests de bout en bout. Aucune dépendance
 * supplémentaire, et surtout : le rapport se régénère par une commande, il ne
 * se remet pas en forme à la main à chaque correction de chiffre.
 *
 * USAGE : node scripts/generer-rapport.js
 */

async function main() {
  const racine = path.resolve(__dirname, '..')
  const source = path.join(racine, 'docs', 'rapport', 'rapport-final.html')
  const sortie = path.join(racine, 'docs', 'rapport', 'RAPPORT-HRFLOW.pdf')

  if (!fs.existsSync(source)) {
    process.stderr.write(`Source introuvable : ${source}\n`)
    process.exit(1)
  }

  process.stdout.write('Ouverture du navigateur…\n')
  const navigateur = await chromium.launch()

  try {
    const page = await navigateur.newPage()
    await page.goto(`file://${source.replace(/\\/g, '/')}`, { waitUntil: 'networkidle' })

    // Les polices distantes doivent être chargées avant le rendu, sinon le PDF
    // sort en police de repli.
    await page.evaluate(() => document.fonts.ready)

    await page.pdf({
      path: sortie,
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '20mm', left: '16mm', right: '16mm' },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: `
        <div style="width:100%;font-family:sans-serif;font-size:7pt;color:#8A8F97;
                    padding:0 16mm;display:flex;justify-content:space-between;">
          <span>NovaTech HRFlow — Rapport de remédiation — Équipe BB_NUMERIQUE</span>
          <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
        </div>`
    })

    const taille = fs.statSync(sortie).size
    process.stdout.write(`Rapport généré : ${path.relative(racine, sortie)} (${Math.round(taille / 1024)} Ko)\n`)
  } finally {
    await navigateur.close()
  }
}

main().catch((err) => {
  process.stderr.write(`Échec de la génération : ${err.message}\n`)
  process.exit(1)
})
