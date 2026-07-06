// ============================================
// UPLOAD DE IMAGENS PARA CLOUDFLARE R2
// Usado pelo dashboard (produtos, loja, cursos).
// O restante dos dados continua salvo no Supabase.
//
// Imagens maiores que o limite são comprimidas automaticamente
// no navegador (reduzindo qualidade/dimensão) antes do envio,
// em vez de simplesmente rejeitar o arquivo.
// ============================================

const R2_MAX_BYTES = 500 * 1024 // 500KB por imagem
const R2_MAX_DIMENSAO = 1600 // px, maior lado da imagem após compressão

function comprimirImagem(file, maxBytes) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new Image()
      img.onload = () => {
        let width = img.width
        let height = img.height
        if (width > R2_MAX_DIMENSAO || height > R2_MAX_DIMENSAO) {
          if (width > height) {
            height = Math.round(height * (R2_MAX_DIMENSAO / width))
            width = R2_MAX_DIMENSAO
          } else {
            width = Math.round(width * (R2_MAX_DIMENSAO / height))
            height = R2_MAX_DIMENSAO
          }
        }

        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, width, height)

        let qualidade = 0.85
        const tentar = () => {
          canvas.toBlob((blob) => {
            if (!blob) {
              reject(new Error('Não foi possível comprimir a imagem.'))
              return
            }
            if (blob.size <= maxBytes || qualidade <= 0.35) {
              resolve(blob)
            } else {
              qualidade -= 0.1
              tentar()
            }
          }, 'image/jpeg', qualidade)
        }
        tentar()
      }
      img.onerror = () => reject(new Error('Não foi possível ler a imagem.'))
      img.src = e.target.result
    }
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'))
    reader.readAsDataURL(file)
  })
}

async function uploadImagemR2(file, folder = 'produtos') {
  if (!file) throw new Error('Nenhum arquivo selecionado.')

  if (!file.type || !file.type.startsWith('image/')) {
    throw new Error(`"${file.name}" não é uma imagem válida.`)
  }

  let arquivoParaEnviar = file
  let nomeParaEnviar = file.name

  if (file.size > R2_MAX_BYTES) {
    if (file.type === 'image/gif') {
      throw new Error(`"${file.name}" tem ${(file.size / 1024).toFixed(0)}KB. GIFs animados não são comprimidos automaticamente aqui — envie um GIF menor que 500KB.`)
    }

    try {
      arquivoParaEnviar = await comprimirImagem(file, R2_MAX_BYTES)
      nomeParaEnviar = file.name.replace(/\.\w+$/, '') + '.jpg'
    } catch (e) {
      throw new Error(`Não foi possível comprimir "${file.name}": ${e.message}`)
    }

    if (arquivoParaEnviar.size > R2_MAX_BYTES) {
      throw new Error(`"${file.name}" é muito grande e não foi possível comprimir abaixo de 500KB. Tente uma imagem menor ou com menos detalhes.`)
    }
  }

  const contentType = arquivoParaEnviar.type || 'image/jpeg'

  const presignRes = await fetch('/.netlify/functions/r2-presign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: nomeParaEnviar,
      contentType,
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
    headers: { 'Content-Type': contentType },
    body: arquivoParaEnviar
  })

  if (!putRes.ok) {
    throw new Error(`Falha ao enviar "${file.name}" para o armazenamento.`)
  }

  return publicUrl
}

// Upload de PDF (apostilas de curso etc.) — sem compressão, limite de 15MB.
const PDF_MAX_BYTES = 15 * 1024 * 1024

async function uploadPdfR2(file, folder = 'cursos') {
  if (!file) throw new Error('Nenhum arquivo selecionado.')

  if (file.type !== 'application/pdf') {
    throw new Error(`"${file.name}" não é um PDF.`)
  }

  if (file.size > PDF_MAX_BYTES) {
    throw new Error(`"${file.name}" tem ${(file.size / 1024 / 1024).toFixed(1)}MB — o limite é 15MB.`)
  }

  const presignRes = await fetch('/.netlify/functions/r2-presign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, contentType: file.type, folder })
  })

  if (!presignRes.ok) {
    let msg = 'Não foi possível preparar o upload do PDF.'
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

// Apaga uma ou mais imagens do R2 (sem travar a ação principal se falhar —
// é só limpeza, nunca deve impedir excluir/trocar algo por causa disso).
async function deletarImagensR2(urls) {
  const lista = (Array.isArray(urls) ? urls : [urls]).filter(Boolean)
  if (lista.length === 0) return

  try {
    await fetch('/.netlify/functions/r2-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: lista })
    })
  } catch (e) {
    console.error('Não foi possível apagar imagem(ns) antigas do armazenamento:', e)
  }
}

window.uploadImagemR2 = uploadImagemR2
window.uploadPdfR2 = uploadPdfR2
window.deletarImagensR2 = deletarImagensR2
window.R2_MAX_BYTES = R2_MAX_BYTES
