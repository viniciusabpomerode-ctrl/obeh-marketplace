// ============================================
// CONEXÃO COM SUPABASE - OBEH MARKETPLACE
// ============================================

const supabaseUrl = 'https://pzvqtpestzrmipcyqbsp.supabase.co'
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB6dnF0cGVzdHpybWlwY3lxYnNwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5MTkwNjUsImV4cCI6MjA5ODQ5NTA2NX0.AeL_tWbCT77miGrmJGd1qFrU50PiV6dOx_DUaj-EvmM'

// Inicializa o cliente Supabase
const supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey)

// ============================================
// FUNÇÕES DE AUTENTICAÇÃO
// ============================================

// Login com email/senha
async function login(email, password) {
  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email,
    password
  })
  if (error) {
    alert('❌ Erro ao fazer login: ' + error.message)
    return false
  }
  window.location.href = 'dashboard.html'
  return true
}

// Login com Google
async function loginComGoogle() {
  const { data, error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin + '/dashboard.html'
    }
  })
  if (error) {
    alert('❌ Erro ao fazer login com Google: ' + error.message)
    return false
  }
  return true
}

// Login com Facebook
async function loginComFacebook() {
  const { data, error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'facebook',
    options: {
      redirectTo: window.location.origin + '/dashboard.html'
    }
  })
  if (error) {
    alert('❌ Erro ao fazer login com Facebook: ' + error.message)
    return false
  }
  return true
}

// Cadastro com email/senha
async function cadastrarUsuario(email, password, nome, telefone) {
  // 1. Cria o usuário
  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: {
      data: {
        nome: nome,
        telefone: telefone
      }
    }
  })

  if (error) {
    alert('❌ Erro no cadastro: ' + error.message)
    return false
  }

  if (data.user) {
    // 2. Cria a loja automaticamente
    const { error: lojaError } = await supabaseClient
      .from('lojas')
      .insert({
        user_id: data.user.id,
        nome_loja: `Loja de ${nome}`,
        ativa: true
      })

    if (lojaError) {
      console.error('Erro ao criar loja:', lojaError)
    }

    alert('✅ Cadastro realizado com sucesso! Faça login para continuar.')
    window.location.href = 'login.html'
    return true
  }

  return false
}

// Logout
async function logout() {
  await supabaseClient.auth.signOut()
  window.location.href = 'index.html'
}

// Pegar usuário atual
async function getCurrentUser() {
  const { data, error } = await supabaseClient.auth.getUser()
  if (error || !data.user) return null
  return data.user
}

// Verificar se está logado (redireciona se não estiver)
async function verificarUsuarioLogado() {
  const user = await getCurrentUser()
  if (!user) {
    window.location.href = 'login.html'
    return null
  }
  return user
}

// ============================================
// FUNÇÕES DE PRODUTOS
// ============================================

async function getProducts() {
  const { data, error } = await supabaseClient
    .from('produtos')
    .select(`
      *,
      lojas (nome_loja, logo, banner),
      categorias (nome)
    `)
    .eq('status', 'ativo')
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Erro ao buscar produtos:', error)
    return []
  }
  return data
}

async function getUserProducts(userId) {
  const { data, error } = await supabaseClient
    .from('produtos')
    .select('*, categorias(nome)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Erro ao buscar produtos do usuário:', error)
    return []
  }
  return data
}

async function criarProduto(produto) {
  const { data, error } = await supabaseClient
    .from('produtos')
    .insert(produto)
    .select()

  if (error) {
    alert('❌ Erro ao criar produto: ' + error.message)
    return null
  }
  return data[0]
}

async function atualizarProduto(id, updates) {
  const { data, error } = await supabaseClient
    .from('produtos')
    .update(updates)
    .eq('id', id)
    .select()

  if (error) {
    alert('❌ Erro ao atualizar: ' + error.message)
    return null
  }
  return data[0]
}

async function deletarProduto(id) {
  if (!confirm('Tem certeza que deseja deletar este produto?')) return false

  const { error } = await supabaseClient
    .from('produtos')
    .delete()
    .eq('id', id)

  if (error) {
    alert('❌ Erro ao deletar: ' + error.message)
    return false
  }

  alert('✅ Produto deletado!')
  return true
}

// ============================================
// FUNÇÕES DE LOJA
// ============================================

async function getLoja(userId) {
  const { data, error } = await supabaseClient
    .from('lojas')
    .select('*')
    .eq('user_id', userId)
    .single()

  if (error && error.code !== 'PGRST116') {
    console.error('Erro ao buscar loja:', error)
    return null
  }
  return data
}

async function atualizarLoja(userId, updates) {
  const { data, error } = await supabaseClient
    .from('lojas')
    .update(updates)
    .eq('user_id', userId)
    .select()

  if (error) {
    alert('❌ Erro ao atualizar loja: ' + error.message)
    return null
  }
  return data[0]
}

// ============================================
// FUNÇÕES DE CATEGORIAS
// ============================================

async function getCategorias() {
  const { data, error } = await supabaseClient
    .from('categorias')
    .select('*')
    .order('nome')

  if (error) {
    console.error('Erro ao buscar categorias:', error)
    return []
  }
  return data
}

// ============================================
// FUNÇÕES DO CARRINHO
// ============================================

let carrinho = []

function adicionarAoCarrinho(produto) {
  const existente = carrinho.find(item => item.id === produto.id)
  if (existente) {
    existente.quantidade += 1
  } else {
    carrinho.push({ ...produto, quantidade: 1 })
  }
  atualizarCarrinhoUI()
}

function removerDoCarrinho(produtoId) {
  carrinho = carrinho.filter(item => item.id !== produtoId)
  atualizarCarrinhoUI()
}

function atualizarQuantidade(produtoId, delta) {
  const item = carrinho.find(i => i.id === produtoId)
  if (!item) return
  item.quantidade += delta
  if (item.quantidade <= 0) {
    carrinho = carrinho.filter(i => i.id !== produtoId)
  }
  atualizarCarrinhoUI()
}

function getTotalCarrinho() {
  return carrinho.reduce((total, item) => total + (item.preco * item.quantidade), 0)
}

function getQuantidadeCarrinho() {
  return carrinho.reduce((total, item) => total + item.quantidade, 0)
}

function atualizarCarrinhoUI() {
  const countEl = document.getElementById('cartCount')
  if (countEl) countEl.textContent = getQuantidadeCarrinho()
}

// ============================================
// FUNÇÕES DE CHAT (COM BLOQUEIO)
// ============================================

async function enviarMensagem(destinatarioId, conteudo) {
  const user = await getCurrentUser()
  if (!user) {
    alert('Faça login para enviar mensagens')
    return false
  }

  // Bloqueia WhatsApp, telefone e email
  const palavrasProibidas = ['whatsapp', 'telefone', 'celular', '@gmail', '@hotmail', '@outlook', '@yahoo', 'zap']
  const conteudoLower = conteudo.toLowerCase()

  for (const palavra of palavrasProibidas) {
    if (conteudoLower.includes(palavra)) {
      alert('❌ Mensagem contém informação de contato proibida (WhatsApp, telefone, etc).')
      return false
    }
  }

  // Bloqueia números de telefone
  const telefoneRegex = /\(?\d{2}\)?\s?\d{4,5}-?\d{4}/g
  if (telefoneRegex.test(conteudo)) {
    alert('❌ Não é permitido enviar números de telefone.')
    return false
  }

  const { data, error } = await supabaseClient
    .from('mensagens')
    .insert({
      remetente_id: user.id,
      destinatario_id: destinatarioId,
      conteudo: conteudo
    })
    .select()

  if (error) {
    alert('Erro ao enviar mensagem: ' + error.message)
    return false
  }

  return data[0]
}

// ============================================
// EXPORTAÇÃO DAS FUNÇÕES (para uso global)
// ============================================

window.supabaseClient = supabaseClient
window.login = login
window.loginComGoogle = loginComGoogle
window.loginComFacebook = loginComFacebook
window.cadastrarUsuario = cadastrarUsuario
window.logout = logout
window.getCurrentUser = getCurrentUser
window.verificarUsuarioLogado = verificarUsuarioLogado
window.getProducts = getProducts
window.getUserProducts = getUserProducts
window.criarProduto = criarProduto
window.atualizarProduto = atualizarProduto
window.deletarProduto = deletarProduto
window.getLoja = getLoja
window.atualizarLoja = atualizarLoja
window.getCategorias = getCategorias
window.adicionarAoCarrinho = adicionarAoCarrinho
window.removerDoCarrinho = removerDoCarrinho
window.atualizarQuantidade = atualizarQuantidade
window.getTotalCarrinho = getTotalCarrinho
window.getQuantidadeCarrinho = getQuantidadeCarrinho
window.enviarMensagem = enviarMensagem
window.carrinho = carrinho