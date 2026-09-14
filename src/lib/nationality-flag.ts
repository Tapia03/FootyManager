// Bandeiras por nacionalidade — o texto vem livre do FM Genie Scout, em
// português (players.nationality). Mapeia nome -> código ISO 3166-1 alpha-2
// e converte pra emoji via "regional indicator symbols" (técnica padrão
// Unicode: cada letra do código vira um indicador regional, os dois juntos
// formam a bandeira). Inglaterra/Escócia/País de Gales não têm código ISO
// próprio (fazem parte do Reino Unido) — usam a sequência de "tag" de
// bandeira preta, também padrão Unicode, reconhecida pela maioria das fontes
// de emoji modernas. Nome sem mapeamento (ex. território sem bandeira
// reconhecida, "País Basco") devolve string vazia — quem renderiza mostra só
// o texto nesse caso, sem quebrar nada.
//
// Cobre as 164 nacionalidades reais encontradas na base atual (ver
// scripts/fm-csv-to-football-db.mjs) — se um país novo aparecer numa base
// futura sem estar aqui, só cai no fallback "sem bandeira, só texto".

const NAME_TO_ISO: Record<string, string> = {
  "Albânia": "AL", "Alemanha": "DE", "Angola": "AO", "Antígua e Barbuda": "AG",
  "Argentina": "AR", "Argélia": "DZ", "Arménia": "AM", "Aruba": "AW", "Arábia Saudita": "SA",
  "Austrália": "AU", "Azerbaijão": "AZ", "Bahrein": "BH", "Bangladesh": "BD", "Barbados": "BB",
  "Benim": "BJ", "Bielorrússia": "BY", "Bolívia": "BO", "Bonaire": "BQ", "Brasil": "BR",
  "Bulgária": "BG", "Burkina Fasso": "BF", "Burundi": "BI", "Bélgica": "BE", "Bósnia": "BA",
  "Cabo Verde": "CV", "Camarões": "CM", "Canadá": "CA", "Cazaquistão": "KZ", "Chade": "TD",
  "Chile": "CL", "Chipre": "CY", "Colômbia": "CO", "Comores": "KM", "Congo": "CD",
  "Coréia do Sul": "KR", "Costa Rica": "CR", "Costa do Marfim": "CI", "Croácia": "HR",
  "Cuba": "CU", "Curaçau": "CW", "Dinamarca": "DK", "Djibuti": "DJ", "Egito": "EG",
  "El Salvador": "SV", "Equador": "EC", "Eritreia": "ER", "Eslováquia": "SK",
  "Eslovénia": "SI", "Espanha": "ES", "Estados Unidos": "US", "Estónia": "EE",
  "Etiópia": "ET", "Filipinas": "PH", "Finlândia": "FI", "França": "FR", "Gabão": "GA",
  "Gana": "GH", "Geórgia": "GE", "Granada": "GD", "Grécia": "GR", "Guadalupe": "GP",
  "Guatemala": "GT", "Guiana": "GY", "Guiana Francesa": "GF", "Guiné": "GN",
  "Guiné Equatorial": "GQ", "Guiné-Bissau": "GW", "Gâmbia": "GM", "Haiti": "HT",
  "Honduras": "HN", "Hong Kong (RP China)": "HK", "Hungria": "HU", "Ilhas Faroé": "FO",
  "Ilhas Martinica": "MQ", "Ilhas Reunião": "RE", "Indonésia": "ID", "Iraque": "IQ",
  "Irlanda do Norte": "GB", "Irã": "IR", "Islândia": "IS", "Israel": "IL", "Itália": "IT",
  "Jamaica": "JM", "Japão": "JP", "Jordânia": "JO", "Kosovo": "XK", "Letónia": "LV",
  "Libéria": "LR", "Lituânia": "LT", "Luxemburgo": "LU", "Líbano": "LB", "Líbia": "LY",
  "Macedónia do Norte": "MK", "Maiote": "YT", "Mali": "ML", "Malta": "MT", "Marrocos": "MA",
  "Mauritânia": "MR", "Maurícia": "MU", "Moldávia": "MD", "Monserrate": "MS",
  "Montenegro": "ME", "Moçambique": "MZ", "México": "MX", "Mónaco": "MC", "Namíbia": "NA",
  "Nigéria": "NG", "Noruega": "NO", "Nova Caledónia": "NC", "Nova Zelândia": "NZ",
  "Níger": "NE", "Palestina": "PS", "Panamá": "PA", "Paquistão": "PK", "Paraguai": "PY",
  "Países Baixos": "NL", "Perú": "PE", "Polônia": "PL", "Porto Rico": "PR", "Portugal": "PT",
  "Quênia": "KE", "Rep. Centro-Africana": "CF", "Rep. do Congo": "CG",
  "República Dominicana": "DO", "República Tcheca": "CZ", "República da Irlanda": "IE",
  "Romênia": "RO", "Rússia": "RU", "S. Tomé e Príncipe": "ST", "S. Vincente": "VC",
  "Samoa Ocidental": "WS", "Senegal": "SN", "Serra Leoa": "SL", "Somália": "SO",
  "St Lucia": "LC", "Sudão": "SD", "Sudão do Sul": "SS", "Suriname": "SR", "Suécia": "SE",
  "Suíça": "CH", "São Cristovão & Nevis": "KN", "Sérvia": "RS", "Síria": "SY",
  "Tanzânia": "TZ", "Timor-Leste": "TL", "Togo": "TG", "Trinidad e Tobago": "TT",
  "Tunísia": "TN", "Turquia": "TR", "Ucrânia": "UA", "Uganda": "UG", "Uruguai": "UY",
  "Uzbequistão": "UZ", "Venezuela": "VE", "Vietnã": "VN", "Zimbabué": "ZW", "Zâmbia": "ZM",
  "África do Sul": "ZA", "Áustria": "AT", "Índia": "IN",
};

// Inglaterra/Escócia/País de Gales — sem código ISO próprio, usam a
// sequência de "tag" de bandeira preta (U+1F3F4 + subdivisão + terminador).
const SPECIAL_FLAGS: Record<string, string> = {
  "Inglaterra": "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
  "Escócia": "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}",
  "País de Gales": "\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}",
};

function isoToFlag(iso2: string): string {
  return [...iso2.toUpperCase()].map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join("");
}

// Nacionalidade dupla vem como "Brasil / Itália" (Genie Scout) — usa a
// primeira pra bandeira, o texto completo continua sendo exibido à parte.
export function nationalityFlag(nationality: string | null | undefined): string {
  if (!nationality) return "";
  const primary = nationality.split("/")[0].trim();
  if (SPECIAL_FLAGS[primary]) return SPECIAL_FLAGS[primary];
  const iso = NAME_TO_ISO[primary];
  return iso ? isoToFlag(iso) : "";
}
