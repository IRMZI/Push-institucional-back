// Pipeline comercial dos leads — a ordem aqui é a ordem do kanban.
const LEAD_STATUS = [
    { key: "novo", label: "Novo" },
    { key: "em_contato", label: "Em contato" },
    { key: "diagnostico_agendado", label: "Diagnóstico agendado" },
    { key: "proposta_enviada", label: "Proposta enviada" },
    { key: "fechado", label: "Fechado" },
    { key: "perdido", label: "Perdido" },
];
const LEAD_STATUS_KEYS = LEAD_STATUS.map((s) => s.key);

const SERVICOS = ["site_landing", "trafego_pago", "estrategia", "nao_sei"];
const SERVICO_LABEL = {
    site_landing: "Site / Landing Page",
    trafego_pago: "Tráfego Pago",
    estrategia: "Estratégia",
    nao_sei: "Não sei ainda",
};

const INVESTIMENTOS = ["nao_invisto", "ate_2k", "2k_5k", "5k_10k", "acima_10k"];
const INVESTIMENTO_LABEL = {
    nao_invisto: "Ainda não invisto",
    ate_2k: "Até R$ 2 mil",
    "2k_5k": "R$ 2–5 mil",
    "5k_10k": "R$ 5–10 mil",
    acima_10k: "Acima de R$ 10 mil",
};

const CONVERSAO_TIPOS = ["lead_form", "whatsapp_click", "instagram_click", "email_click", "cta_click"];

// Qual evento padrão da Meta cada conversão representa (null = não vai para a CAPI)
const CAPI_EVENT_BY_TIPO = {
    lead_form: "Lead",
    whatsapp_click: "Contact",
    email_click: "Contact",
    instagram_click: null,
    cta_click: null,
};

const EVENT_TIPOS = [
    "page_view",
    "section_view",
    "scroll_depth",
    "time_on_page",
    "case_click",
    "service_click",
    "cta_click",
    "link_click",
    "form_open",
    "form_start",
    "form_submit",
    "form_error",
    "consent",
];

module.exports = {
    LEAD_STATUS,
    LEAD_STATUS_KEYS,
    SERVICOS,
    SERVICO_LABEL,
    INVESTIMENTOS,
    INVESTIMENTO_LABEL,
    CONVERSAO_TIPOS,
    CAPI_EVENT_BY_TIPO,
    EVENT_TIPOS,
};
