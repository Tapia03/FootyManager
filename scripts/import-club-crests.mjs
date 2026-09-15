// -----------------------------------------------------------------------------
// Casa um pack de escudos reais (pasta local de imagens, ex. extraída de um
// zip de logos de clube tipo sortitoutsi/FMScout) com os clubes de
// data/football-db/<país>/clubs.json, por nome normalizado — mesmo padrão de
// scripts/fetch-stadiums.mjs (que fez o mesmo pra estádio/fundação via
// openfootball). Converte cada imagem casada pra webp (256×256 max, via
// sharp) em public/crests/<id-do-clube>.webp e grava clubs.json com
// crest_url = "/crests/<id>.webp" — Vite serve public/ como está tanto no
// dev quanto no build empacotado do Tauri (frontendDist = dist/client
// inteiro), então não precisa de nenhum passo extra de deploy.
//
// A estrutura de nome de arquivo varia de pack pra pack (nome do clube?
// sigla? ID interno da SI sem nome nenhum?) — esse script tenta a heurística
// mais comum (nome do arquivo ≈ nome do clube, com ou sem ID na frente) e
// reporta honestamente quem não casou, pros dois lados (arquivo sem clube E
// clube sem arquivo). Nunca inventa match.
//
// Uso:
//   node scripts/import-club-crests.mjs <pasta-com-as-imagens> [data/football-db]
// -----------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import sharp from "sharp";

const INPUT_DIR = process.argv[2];
const DB_DIR = process.argv[3] || path.join(process.cwd(), "data", "football-db");
const OUT_DIR = path.join(process.cwd(), "public", "crests");

const IMAGE_EXT = /\.(png|jpe?g|webp|svg)$/i;

if (!INPUT_DIR) {
  console.error("Uso: node scripts/import-club-crests.mjs <pasta-com-as-imagens> [data/football-db]");
  process.exit(1);
}
if (!fs.existsSync(INPUT_DIR)) {
  console.error(`Pasta não encontrada: ${INPUT_DIR}`);
  process.exit(1);
}

// Mesma normalização de scripts/fetch-stadiums.mjs (minúsculo, sem acento,
// sem sufixo genérico de clube, só alfanumérico) — assim "SE Palmeiras",
// "Palmeiras FC" e "palmeiras.png" caem na mesma chave.
const GENERIC_SUFFIX = /\b(fc|cf|sc|ac|afc|cd|ce|ec|ca|ud|sd|rc|club|clube|futebol|futbol|calcio|clube de regatas|esporte clube|associação|atlético|atletico)\b/g;
function normalize(s) {
  return s
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(GENERIC_SUFFIX, "")
    .replace(/[^a-z0-9]/g, "");
}

// Nome candidato a partir do nome do arquivo: tira extensão, troca
// _/-/. por espaço, tira um prefixo/sufixo de ID puramente numérico (comum
// em pack organizado por ID da SI, ex. "123456 Flamengo.png" ou
// "Flamengo_123456.png") — se sobrar só dígito, o arquivo fica sem candidato
// de nome (cai no relatório de "sem match", não tenta adivinhar).
function candidateNameFromFilename(file) {
  const base = file.replace(IMAGE_EXT, "").replace(/[_.-]+/g, " ").trim();
  const stripped = base.replace(/^\d+\s+/, "").replace(/\s+\d+$/, "").trim();
  return stripped || null;
}

function walkImages(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkImages(full));
    else if (IMAGE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

async function main() {
  // Índice nome-normalizado -> { club, country, clubsPath, clubs } de TODOS
  // os países de uma vez (o pack não segue necessariamente nossa pasta por
  // país).
  const lookup = new Map();
  const byCountry = new Map();
  let totalClubs = 0;

  for (const country of fs.readdirSync(DB_DIR).sort()) {
    const dir = path.join(DB_DIR, country);
    if (!fs.statSync(dir).isDirectory()) continue;
    const clubsPath = path.join(dir, "clubs.json");
    if (!fs.existsSync(clubsPath)) continue;
    const clubs = JSON.parse(fs.readFileSync(clubsPath, "utf8"));
    byCountry.set(country, { clubsPath, clubs });
    totalClubs += clubs.length;
    for (const c of clubs) {
      const key = normalize(c.name);
      if (key && !lookup.has(key)) lookup.set(key, c);
    }
  }

  const images = walkImages(INPUT_DIR);
  console.log(`Encontrei ${images.length} imagens em ${INPUT_DIR}, ${totalClubs} clubes na base.`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  let matched = 0;
  const unmatchedFiles = [];
  const matchedClubIds = new Set();

  for (const imgPath of images) {
    const file = path.basename(imgPath);
    const candidate = candidateNameFromFilename(file);
    if (!candidate) {
      unmatchedFiles.push(file);
      continue;
    }
    const club = lookup.get(normalize(candidate));
    if (!club) {
      unmatchedFiles.push(file);
      continue;
    }
    const outFile = path.join(OUT_DIR, `${club.id}.webp`);
    await sharp(imgPath)
      .resize(256, 256, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 90 })
      .toFile(outFile);
    club.crest_url = `/crests/${club.id}.webp`;
    matchedClubIds.add(club.id);
    matched++;
  }

  for (const { clubsPath, clubs } of byCountry.values()) {
    fs.writeFileSync(clubsPath, JSON.stringify(clubs, null, 2));
  }

  console.log(`\n${matched}/${images.length} imagens casadas com um clube.`);
  console.log(`${matchedClubIds.size}/${totalClubs} clubes da base ganharam escudo real.`);
  if (unmatchedFiles.length) {
    console.log(`\n${unmatchedFiles.length} imagens sem match (primeiras 20):`);
    for (const f of unmatchedFiles.slice(0, 20)) console.log(`  - ${f}`);
  }
}

main();
