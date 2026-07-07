// ============================================
// MAPEAMENTO: PRODUTO EXTRAÍDO -> PRODUTO DO OBEH
// Traduz o que um adapter (ex: artesanou-adapter.js) extraiu pra estrutura
// de produto do Obeh, aplicando três regras:
//
// 1) OBRIGATÓRIOS (nome, preço) — se faltarem, o produto entra com
//    extracao_incompleta=true e não é publicado automaticamente.
// 2) OPCIONAIS EXTRAÍVEIS (categoria, descrição, fotos, estoque, preço
//    antigo/promoção, sob encomenda/prazo) — se ausentes, salva vazio/null
//    e publica assim mesmo.
// 3) IMPOSSÍVEIS DE EXTRAIR (peso e dimensões) — sempre null, sempre marca
//    pendente_dados_frete=true.
// ============================================

// Tenta casar o texto da categoria de origem com uma categoria já cadastrada
// no Obeh (comparação simples por nome aproximado, sem acento/maiúsculas).
function normalizarTexto(txt) {
  return String(txt || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
    .toLowerCase()
    .trim()
}

function mapearCategoria(categoriaOrigemTexto, categoriasObeh) {
  if (!categoriaOrigemTexto) return { categoriaId: null, precisaRevisao: true }

  const alvo = normalizarTexto(categoriaOrigemTexto)
  const exata = categoriasObeh.find(c => normalizarTexto(c.nome) === alvo)
  if (exata) return { categoriaId: exata.id, precisaRevisao: false }

  // fuzzy simples: categoria do Obeh contida no texto de origem ou vice-versa
  const parcial = categoriasObeh.find(c => {
    const nome = normalizarTexto(c.nome)
    return alvo.includes(nome) || nome.includes(alvo)
  })
  if (parcial) return { categoriaId: parcial.id, precisaRevisao: false }

  return { categoriaId: null, precisaRevisao: true } // "Sem categoria", sinalizado
}

function mapearProdutoImportado(extraido, { categoriasObeh, plataforma }) {
  const nome = (extraido.titulo || '').trim()
  const precoAtual = extraido.precoAtual

  // 1) OBRIGATÓRIOS
  const extracaoIncompleta = !nome || !precoAtual || precoAtual <= 0

  // 2) OPCIONAIS
  const { categoriaId, precisaRevisao: categoriaPrecisaRevisao } = mapearCategoria(extraido.categoriaTexto, categoriasObeh)

  const temPrecoAntigo = Boolean(extraido.precoAntigo && extraido.precoAntigo > (precoAtual || 0))
  const precoAntigo = temPrecoAntigo ? extraido.precoAntigo : null

  const sobEncomenda = Boolean(extraido.sobEncomenda)
  const prazoProducaoDias = sobEncomenda ? (extraido.prazoProducaoDias || null) : null

  const imagens = Array.isArray(extraido.imagens) ? extraido.imagens.slice(0, 4) : []
  const semImagem = imagens.length === 0

  // 3) IMPOSSÍVEIS DE EXTRAIR — nunca vêm de nenhuma origem
  const peso_kg = null
  const altura_cm = null
  const largura_cm = null
  const comprimento_cm = null

  return {
    nome: nome || `(sem título — ${extraido.urlOrigem})`,
    preco: precoAtual || 0,
    descricao: extraido.descricao || null,
    categoria_id: categoriaId,
    estoque: 1, // origem não expõe estoque publicamente — usa o mesmo padrão do cadastro manual
    em_promocao: false, // habilitação sempre manual, mesmo com preço riscado vindo da origem
    preco_antigo: precoAntigo,
    destaque: false, // NUNCA vem da origem — é sempre uma decisão manual do vendedor no Obeh
    sob_encomenda: sobEncomenda,
    prazo_producao_dias: prazoProducaoDias,
    peso_kg,
    altura_cm,
    largura_cm,
    comprimento_cm,
    imagensOrigem: imagens, // urls ainda não enviadas ao R2 — quem chama esta função sobe as imagens depois
    pasta_nome: extraido.pastaOrigemTexto || null, // nome da pasta na loja de origem

    // Metadados de controle da importação
    url_origem: extraido.urlOrigem,
    origem_importacao: plataforma,
    extracao_incompleta: extracaoIncompleta,
    sem_imagem: semImagem,
    pendente_dados_frete: true, // peso/dimensões são sempre impossíveis de obter da origem
    categoria_precisa_revisao: categoriaPrecisaRevisao // não é campo do banco — só pro resumo da UI
  }
}

module.exports = { mapearProdutoImportado, mapearCategoria, normalizarTexto }
