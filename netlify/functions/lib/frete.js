// ============================================
// LIB - CÁLCULO DE FRETE (compartilhado)
// Lógica usada tanto pelo endpoint público calcular-frete.js (chamado pelo
// carrinho, no navegador) quanto pelas funções de pagamento
// (mp-criar-pix.js, mp-criar-pagamento.js, mp-criar-pagamento-cartao.js).
//
// Antes, as funções de pagamento chamavam calcular-frete.js via HTTP (fetch
// pro próprio site, usando SITE_URL) pra descobrir o valor do frete. Isso é
// fràgil: se SITE_URL estiver errado/desatualizado, ou a chamada falhar por
// qualquer motivo, o valor cobrado no pagamento acaba diferente do valor
// mostrado no carrinho (foi exatamente o bug relatado). Agora as duas
// pontas chamam essa mesma função diretamente, sem HTTP no meio — garante
// que o valor calculado é sempre o mesmo dos dois lados.
//
// Ordem de prioridade pra cada loja:
//   1) SuperFrete, se a loja tiver um token pessoal cadastrado (lojas.superfrete_token)
//   2) Correios (API oficial), se o servidor tiver credenciais configuradas
//   3) Frete manual por região (tabela fretes_regiao), se a loja tiver faixas cadastradas
//   4) Estimativa aproximada baseada só no peso, como último recurso
// ============================================
const SUPABASE_URL = 'https://pzvqtpestzrmipcyqbsp.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const CORREIOS_USUARIO = process.env.CORREIOS_USUARIO
const CORREIOS_CODIGO_ACESSO = process.env.CORREIOS_CODIGO_ACESSO
const CORREIOS_NUMERO_CARTAO = process.env.CORREIOS_NUMERO_CARTAO
const CORREIOS_CONTRATO = process.env.CORREIOS_CONTRATO
const CORREIOS_DR = process.env.CORREIOS_DR

const SUPERFRETE_BASE_URL = process.env.SUPERFRETE_BASE_URL || 'https://api.superfrete.com'
const SUPERFRETE_CONTATO = process.env.SUPERFRETE_CONTATO || 'contato@obeh.com.br'

// Códigos de serviço da própria SuperFrete (não são os mesmos códigos dos
// Correios) — 1 = PAC, 2 = SEDEX, 17 = Mini Envios. O campo "services" é
// OBRIGATÓRIO na API deles; sem ele a chamada falha com 400 e cai pro
// próximo método de frete sem nem perceber.
const SUPERFRETE_SERVICOS = '1,2,17'

function regiaoPorCep(cepDestino) {
  const prefixo = Number(String(cepDestino).slice(0, 2))
  if (prefixo <= 39) return 'Sudeste' // SP, RJ, ES, MG
  if (prefixo <= 65) return 'Nordeste' // BA, SE, PE, AL, PB, RN, CE, PI, MA
  if (prefixo <= 69) return 'Norte' // PA, AP, AM, RR, AC
  if (prefixo === 77) return 'Norte' // TO
  if (prefixo <= 76 || prefixo === 78 || prefixo === 79) return 'Centro-Oeste' // DF, GO, MT, MS
  return 'Sul' // PR, SC, RS
}

// Códigos de serviço dos Correios (tabela pública, não muda por contrato)
const SERVICOS_CORREIOS = [
  { codigo: '03298', nome: 'PAC' },
  { codigo: '03220', nome: 'SEDEX' }
]

let tokenCacheCorreios = { valor: null, expiraEm: 0 }

async function supabaseRequest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase ${path} falhou (${res.status}): ${text}`)
  }
  return res.json()
}

async function getTokenCorreios() {
  const agora = Date.now()
  if (tokenCacheCorreios.valor && tokenCacheCorreios.expiraEm > agora) {
    return tokenCacheCorreios.valor
  }

  const auth = Buffer.from(`${CORREIOS_USUARIO}:${CORREIOS_CODIGO_ACESSO}`).toString('base64')
  const res = await fetch('https://api.correios.com.br/token/v1/autentica/cartaopostagem', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      numero: CORREIOS_NUMERO_CARTAO,
      contrato: CORREIOS_CONTRATO,
      dr: Number(CORREIOS_DR)
    })
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Falha ao autenticar na API dos Correios (${res.status}): ${text}`)
  }

  const data = await res.json()
  tokenCacheCorreios = {
    valor: data.token,
    expiraEm: agora + 45 * 60 * 1000
  }
  return data.token
}

function calcularEstimativaAproximada(pesoTotalKg) {
  const base = 15
  const porKgExtra = 4
  const pesoExtra = Math.max(0, pesoTotalKg - 1)
  const valor = Math.round((base + pesoExtra * porKgExtra) * 100) / 100

  return {
    estimativaAproximada: true,
    opcoes: [
      { servico: 'estimativa', nome: 'Frete estimado', preco: valor, prazoDias: null }
    ]
  }
}

async function calcularFreteReal(cepOrigem, cepDestino, pesoTotalKg, dimensoes) {
  const token = await getTokenCorreios()
  const opcoes = []

  for (const servico of SERVICOS_CORREIOS) {
    const params = new URLSearchParams({
      cepOrigem: cepOrigem.replace(/\D/g, ''),
      cepDestino: cepDestino.replace(/\D/g, ''),
      psObjeto: String(pesoTotalKg),
      tpObjeto: '2',
      comprimento: String(dimensoes.comprimento),
      largura: String(dimensoes.largura),
      altura: String(dimensoes.altura)
    })

    const res = await fetch(`https://api.correios.com.br/preco/v1/nacional/${servico.codigo}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` }
    })

    if (!res.ok) continue

    const data = await res.json()
    const preco = Number(String(data.pcFinal || data.preco || '0').replace(',', '.'))
    if (!preco) continue

    opcoes.push({
      servico: servico.codigo,
      nome: servico.nome,
      preco,
      prazoDias: data.prazoEntrega ? Number(data.prazoEntrega) : null
    })
  }

  if (opcoes.length === 0) {
    throw new Error('Nenhum serviço dos Correios retornou preço.')
  }

  return { estimativaAproximada: false, opcoes }
}

async function calcularFreteSuperFrete(token, cepOrigem, cepDestino, produtosGrupo) {
  const res = await fetch(`${SUPERFRETE_BASE_URL}/api/v0/calculator`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': `Obeh Marketplace (${SUPERFRETE_CONTATO})`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: { postal_code: cepOrigem.replace(/\D/g, '') },
      to: { postal_code: cepDestino.replace(/\D/g, '') },
      services: SUPERFRETE_SERVICOS,
      products: produtosGrupo.map(p => ({
        quantity: p.quantidade,
        height: p.altura,
        length: p.comprimento,
        width: p.largura,
        weight: p.peso
      }))
    })
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`SuperFrete respondeu ${res.status}: ${text}`)
  }

  const data = await res.json()
  const lista = Array.isArray(data) ? data : (data.opcoes || data.options || [])
  const opcoes = lista
    .filter(o => !o.has_error && !o.error && (o.price || o.custom_price))
    .map(o => ({
      servico: String(o.id ?? o.name ?? 'superfrete'),
      nome: o.name || 'Frete',
      preco: Number(o.custom_price ?? o.price),
      prazoDias: o.delivery_time ? Number(o.delivery_time) : (o.delivery_range?.max ? Number(o.delivery_range.max) : null)
    }))

  if (opcoes.length === 0) {
    throw new Error('SuperFrete não retornou nenhuma opção válida.')
  }

  return { estimativaAproximada: false, opcoes }
}

function calcularFreteManualPorRegiao(faixas, cepDestino, quantidadeTotal) {
  const regiao = regiaoPorCep(cepDestino)
  const faixa = faixas.find(f =>
    f.regiao === regiao &&
    quantidadeTotal >= f.quantidade_min &&
    quantidadeTotal <= f.quantidade_max
  )
  if (!faixa) return null

  const preco = faixa.frete_gratis ? 0 : Number(faixa.preco)
  return {
    estimativaAproximada: false,
    opcoes: [
      { servico: 'manual', nome: faixa.frete_gratis ? 'Frete grátis' : 'Frete', preco, prazoDias: null }
    ]
  }
}

// Calcula o frete pra cada loja envolvida nos itens informados. Retorna um
// array no formato: [{ lojaId, nomeLoja, estimativaAproximada, opcoes }]
async function calcularFretesPorLoja(cepDestino, itens) {
  const cepLimpo = String(cepDestino || '').replace(/\D/g, '')
  if (cepLimpo.length !== 8 || !Array.isArray(itens) || itens.length === 0) {
    return []
  }

  const ids = itens.map(i => i.produtoId).filter(Boolean)
  if (ids.length === 0) return []

  // Região do CEP de destino — usada tanto pro frete manual por região
  // quanto pro frete grátis por região marcado no produto.
  const regiaoDestino = regiaoPorCep(cepLimpo)

  // Se a coluna frete_gratis_regioes ainda não existir no banco (migração
  // pendente), o PostgREST rejeita a consulta INTEIRA — o que quebraria o
  // cálculo de frete por completo, não só o frete grátis. Tenta com a coluna
  // primeiro; se falhar, refaz sem ela (frete grátis só some, o resto do
  // cálculo de frete continua funcionando normalmente).
  let produtos
  try {
    produtos = await supabaseRequest(
      `produtos?id=in.(${ids.join(',')})&select=id,loja_id,peso_kg,altura_cm,largura_cm,comprimento_cm,frete_gratis_regioes,lojas(id,nome_loja,cep_origem,superfrete_token)`
    )
  } catch (err) {
    console.error('Falha ao buscar produtos com frete_gratis_regioes (coluna pode não existir ainda), tentando sem ela:', err.message)
    produtos = await supabaseRequest(
      `produtos?id=in.(${ids.join(',')})&select=id,loja_id,peso_kg,altura_cm,largura_cm,comprimento_cm,lojas(id,nome_loja,cep_origem,superfrete_token)`
    )
  }

  const porLoja = {}
  for (const item of itens) {
    const produto = produtos.find(p => p.id === item.produtoId)
    if (!produto) continue
    const lojaId = produto.loja_id
    if (!porLoja[lojaId]) {
      porLoja[lojaId] = {
        lojaId,
        nomeLoja: produto.lojas?.nome_loja || 'Loja',
        cepOrigem: produto.lojas?.cep_origem || null,
        superfreteToken: produto.lojas?.superfrete_token || null,
        quantidadeTotal: 0,
        pesoTotalKg: 0,
        altura: 10,
        largura: 15,
        comprimento: 20,
        itensDetalhados: [],
        // Só considera o grupo inteiro "frete grátis" se TODOS os produtos
        // dessa loja no carrinho tiverem frete grátis pra REGIÃO do
        // comprador — misturar um produto com frete grátis (naquela região)
        // e outro sem no mesmo pacote não tem como dar pra cobrar "meio
        // frete", então nesse caso cobra o frete normal.
        todosFreteGratis: true
      }
    }
    const grupo = porLoja[lojaId]
    const quantidade = Number(item.quantidade || 1)
    grupo.quantidadeTotal += quantidade
    grupo.pesoTotalKg += Number(produto.peso_kg || 0.3) * quantidade
    grupo.altura = Math.max(grupo.altura, Number(produto.altura_cm || 10))
    grupo.largura = Math.max(grupo.largura, Number(produto.largura_cm || 15))
    grupo.comprimento = Math.max(grupo.comprimento, Number(produto.comprimento_cm || 20))
    const regioesGratisDoProduto = Array.isArray(produto.frete_gratis_regioes) ? produto.frete_gratis_regioes : []
    grupo.todosFreteGratis = grupo.todosFreteGratis && regioesGratisDoProduto.includes(regiaoDestino)
    grupo.itensDetalhados.push({
      quantidade,
      peso: Number(produto.peso_kg || 0.3),
      altura: Number(produto.altura_cm || 10),
      largura: Number(produto.largura_cm || 15),
      comprimento: Number(produto.comprimento_cm || 20)
    })
  }

  const credenciaisCorreiosOk = CORREIOS_USUARIO && CORREIOS_CODIGO_ACESSO && CORREIOS_NUMERO_CARTAO && CORREIOS_CONTRATO && CORREIOS_DR

  const lojaIdsComGrupo = Object.keys(porLoja)
  const todasFaixas = lojaIdsComGrupo.length > 0
    ? await supabaseRequest(`fretes_regiao?loja_id=in.(${lojaIdsComGrupo.join(',')})&select=*`)
    : []

  const fretes = []
  for (const grupo of Object.values(porLoja)) {
    let resultado = null

    // Se TODOS os produtos dessa loja no carrinho têm frete grátis marcado
    // no cadastro, nem precisa consultar SuperFrete/Correios — já é grátis.
    if (grupo.todosFreteGratis) {
      resultado = {
        estimativaAproximada: false,
        opcoes: [{ servico: 'gratis', nome: 'Frete grátis', preco: 0, prazoDias: null }]
      }
    }

    // Cada loja usa SOMENTE o próprio token cadastrado no dashboard
    // (lojas.superfrete_token). Isso é um marketplace: NUNCA usar um token
    // global aqui, senão o frete de todas as lojas sairia da conta
    // SuperFrete de um único vendedor.
    if (!resultado && grupo.superfreteToken) {
      if (!grupo.cepOrigem) {
        console.error(`SuperFrete: loja ${grupo.lojaId} tem token mas está SEM "CEP de origem" cadastrado — pulando SuperFrete.`)
      } else {
        try {
          resultado = await calcularFreteSuperFrete(grupo.superfreteToken, grupo.cepOrigem, cepLimpo, grupo.itensDetalhados)
        } catch (err) {
          console.error('Falha ao calcular frete via SuperFrete, tentando próxima opção:', err.message)
        }
      }
    }

    if (!resultado && credenciaisCorreiosOk && grupo.cepOrigem) {
      try {
        resultado = await calcularFreteReal(grupo.cepOrigem, cepLimpo, grupo.pesoTotalKg, {
          altura: grupo.altura,
          largura: grupo.largura,
          comprimento: grupo.comprimento
        })
      } catch (err) {
        console.error('Falha ao calcular frete real, tentando próxima opção:', err.message)
      }
    }

    if (!resultado) {
      const faixasDaLoja = todasFaixas.filter(f => f.loja_id === grupo.lojaId)
      resultado = calcularFreteManualPorRegiao(faixasDaLoja, cepLimpo, grupo.quantidadeTotal)
    }

    if (!resultado) {
      resultado = calcularEstimativaAproximada(grupo.pesoTotalKg)
    }

    fretes.push({
      lojaId: grupo.lojaId,
      nomeLoja: grupo.nomeLoja,
      ...resultado
    })
  }

  return fretes
}

module.exports = { calcularFretesPorLoja }
