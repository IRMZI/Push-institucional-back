const crypto = require("crypto");
const sharp = require("sharp");
const sql = require("../db");

// Larguras geradas para o srcset (nunca maiores que o original)
const WIDTHS = [640, 1280, 1920];
const FORMATS = {
    avif: (img) => img.avif({ quality: 55, effort: 4 }),
    webp: (img) => img.webp({ quality: 78 }),
};
const ACCEPTED = /^image\/(jpeg|png|webp|avif|gif|heic|heif|tiff)$/;
const MAX_PIXELS = 40_000_000;

/** Processa o upload: corrige rotação (EXIF), remove metadados, gera AVIF + WebP em 3 larguras. */
async function processUpload(buffer, { nome, mime, alt, autor }) {
    if (!ACCEPTED.test(mime || "")) throw Object.assign(new Error("Formato não suportado. Use JPG, PNG, WebP ou AVIF."), { status: 415 });
    const base = sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: "error" }).rotate();
    const meta = await base.metadata();
    const oriented = meta.orientation && meta.orientation >= 5;
    const width = oriented ? meta.height : meta.width;
    const height = oriented ? meta.width : meta.height;
    if (!width || !height) throw Object.assign(new Error("Imagem inválida."), { status: 400 });

    const widths = [...new Set(WIDTHS.map((w) => Math.min(w, width)))];
    const id = crypto.randomUUID();
    const variants = [];
    for (const w of widths) {
        for (const [fmt, encode] of Object.entries(FORMATS)) {
            const out = await encode(base.clone().resize({ width: w, withoutEnlargement: true })).toBuffer();
            variants.push({ media_id: id, largura: w, formato: fmt, conteudo: out, tamanho: out.length });
        }
    }
    const total = variants.reduce((a, v) => a + v.tamanho, 0);
    await sql.begin(async (tx) => {
        await tx`
          INSERT INTO media (id, nome, mime_original, width, height, larguras, alt, tamanho_total, criado_por)
          VALUES (${id}, ${(nome || "").slice(0, 255) || null}, ${mime}, ${width}, ${height}, ${widths}, ${alt || null}, ${total}, ${autor || null})`;
        await tx`INSERT INTO media_variants ${tx(variants, "media_id", "largura", "formato", "conteudo", "tamanho")}`;
    });
    return { id, nome, width, height, larguras: widths, alt: alt || null, tamanho_total: total };
}

// Representação pública de uma mídia (o front monta as URLs /api/media/:id/:largura.:formato)
const mediaJson = (m, alt) =>
    m && m.id ? { id: m.id, width: m.width, height: m.height, larguras: m.larguras, alt: alt ?? m.alt ?? "" } : null;

async function mediaByIds(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const rows = await sql`SELECT id, width, height, larguras, alt FROM media WHERE id IN ${sql(unique)}`;
    return new Map(rows.map((r) => [r.id, r]));
}

module.exports = { processUpload, mediaJson, mediaByIds, WIDTHS };
