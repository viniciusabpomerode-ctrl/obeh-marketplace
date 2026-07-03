// ============================================
// UPLOAD DE IMAGENS PARA CLOUDFLARE R2
// Usado pelo dashboard (produtos, loja, cursos).
// O restante dos dados continua salvo no Supabase.
// ============================================

const R2_MAX_BYTES = 500 * 1024 // 500KB por imagem

async function uploadImagemR2(file, folder = 'produtos') {
  if (!file) throw new Error('Nenhum arquivo selecionado.')

  if (!file.type || !file.type.startsWith('image/')) {
    throw new Error(`"${file.name}" não é uma imagem válida.`)
  }

  if (file.size > R2_MAX_BYTES) {
    throw new Error(`"${file.name}" tem ${(file.size / 1024).toFixed(0)}KB. O limite é 500KB por imagem.`)
  }

  const presignRes = await fetch('/.netlify/functions/r2-presign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type,
      folder
    })
  })

  if (!presignRes.ok) {
    let msg = 'Não foi possível preparar o upload da imagem.'
    try {
      const errBody = await presignRes.json()
      if (errBody?.error) msg = errBody.error
    } catch (e) {}
    throw new Error(msg)
  }

  const { uploadUrl, publicUrl } = await presignRes.json()

  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file
  })

  if (!putRes.ok) {
    throw new Error(`Falha ao enviar "${file.name}" para o armazenamento.`)
  }

  return publicUrl
}

window.uploadImagemR2 = uploadImagemR2
window.R2_MAX_BYTES = R2_MAX_BYTES
