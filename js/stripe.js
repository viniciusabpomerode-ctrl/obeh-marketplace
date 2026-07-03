// ============================================
// STRIPE - ASSINATURAS (Basic / Pro / Ultra)
// ============================================
// Importante: assinaturas de plano são cobradas via Stripe.
// A compra de produtos artesanais NÃO passa pelo Stripe — o pagamento
// vai direto para o Mercado Pago de cada artesão (ver checkout do carrinho).
//
// O pagamento da assinatura acontece embutido no próprio site (assinar.html),
// usando o Stripe Embedded Checkout — o cliente nunca sai do domínio do Obeh.

function redirectToCheckout(plano) {
  const planosValidos = ['basic', 'pro', 'ultra']
  if (!planosValidos.includes(plano)) {
    alert('❌ Plano inválido.')
    return
  }
  window.location.href = `assinar.html?plano=${plano}`
}

// ===== CONFIRMA ASSINATURA AO VOLTAR DO STRIPE =====
async function confirmarAssinaturaPendente() {
  const params = new URLSearchParams(window.location.search)
  if (params.get('assinatura') !== 'sucesso') return

  const plano = params.get('plano')
  const planosValidos = ['basic', 'pro', 'ultra']
  if (!plano || !planosValidos.includes(plano)) return

  const user = await getCurrentUser()
  if (!user) return

  try {
    await supabaseClient.from('users').update({ plano }).eq('id', user.id)
    await supabaseClient.from('assinaturas').insert({ user_id: user.id, plano, status: 'ativa' })
    alert('✅ Assinatura confirmada! Seu plano agora é ' + plano.toUpperCase() + '.')
  } catch (err) {
    console.error('Erro ao confirmar assinatura:', err)
  }

  // limpa os parâmetros da URL
  window.history.replaceState({}, document.title, window.location.pathname)
}

window.redirectToCheckout = redirectToCheckout
window.confirmarAssinaturaPendente = confirmarAssinaturaPendente
