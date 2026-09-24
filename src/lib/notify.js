const crypto = require("crypto");
const { config } = require("../config");
const { SERVICO_LABEL, INVESTIMENTO_LABEL } = require("./constants");
const { formatBR } = require("./phone");

let transporter = null;
function getTransporter() {
    const { smtp } = config.notify;
    if (!smtp.host) return null;
    if (!transporter) {
        const nodemailer = require("nodemailer");
        transporter = nodemailer.createTransport({
            host: smtp.host,
            port: smtp.port,
            secure: smtp.secure,
            auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
        });
    }
    return transporter;
}

function leadSummary(lead) {
    return {
        id: lead.id,
        nome: lead.nome,
        whatsapp: lead.whatsapp,
        whatsapp_formatado: formatBR(lead.whatsapp),
        email: lead.email,
        empresa: lead.empresa,
        servicos: (lead.servicos || []).map((s) => SERVICO_LABEL[s] || s),
        investimento: INVESTIMENTO_LABEL[lead.investimento] || lead.investimento,
        mensagem: lead.mensagem,
        origem: lead.utm_source || null,
        campanha: lead.utm_campaign || null,
        pagina: lead.pagina_origem,
        criado_em: lead.criado_em,
        whatsapp_link: `https://wa.me/${lead.whatsapp}`,
        painel_url: config.panelUrl ? `${config.panelUrl}/dashboard/leads/${lead.id}` : null,
    };
}

async function sendWebhook(lead) {
    const { webhookUrl, webhookSecret } = config.notify;
    if (!webhookUrl) return;
    const body = JSON.stringify({ evento: "lead.criado", origem: "site-push", lead: leadSummary(lead) });
    const headers = { "Content-Type": "application/json" };
    // Assinatura HMAC opcional para o CRM validar a origem
    if (webhookSecret) {
        headers["X-Push-Signature"] = `sha256=${crypto.createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
    }
    const res = await fetch(webhookUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`webhook respondeu HTTP ${res.status}`);
}

const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function sendEmail(lead) {
    const t = getTransporter();
    if (!t || config.notify.email.length === 0) return;
    const s = leadSummary(lead);
    const rows = [
        ["Nome", s.nome],
        ["WhatsApp", s.whatsapp_formatado],
        ["E-mail", s.email],
        ["Empresa / Instagram", s.empresa],
        ["Precisa de", s.servicos.join(", ")],
        ["Investimento em mídia", s.investimento],
        ["Mensagem", s.mensagem],
        ["Origem", [s.origem, s.campanha].filter(Boolean).join(" / ") || "direto"],
    ].filter(([, v]) => v);
    await t.sendMail({
        from: config.notify.smtp.from,
        to: config.notify.email,
        subject: `Novo lead no site — ${s.nome}`,
        text: rows.map(([k, v]) => `${k}: ${v}`).join("\n") + `\n\nWhatsApp: ${s.whatsapp_link}\n${s.painel_url || ""}`,
        html: `<div style="font-family:Inter,Arial,sans-serif;font-size:14px;color:#080B10">
<h2 style="font-family:Sora,Arial,sans-serif;margin:0 0 16px">Novo lead — ${esc(s.nome)}</h2>
<table cellpadding="6" style="border-collapse:collapse">${rows
            .map(([k, v]) => `<tr><td style="color:#666">${esc(k)}</td><td><strong>${esc(v)}</strong></td></tr>`)
            .join("")}</table>
<p><a href="${esc(s.whatsapp_link)}" style="color:#164BFF">Chamar no WhatsApp</a>${
            s.painel_url ? ` · <a href="${esc(s.painel_url)}" style="color:#164BFF">Abrir no painel</a>` : ""
        }</p></div>`,
    });
}

// Dispara todas as notificações sem bloquear a resposta ao visitante.
function notifyNewLead(lead) {
    Promise.allSettled([sendWebhook(lead), sendEmail(lead)]).then((results) => {
        results.forEach((r, i) => {
            if (r.status === "rejected") console.warn(`[notify] ${i === 0 ? "webhook" : "e-mail"} falhou:`, r.reason?.message);
        });
    });
}

module.exports = { notifyNewLead, leadSummary };
