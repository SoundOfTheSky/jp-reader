// ==UserScript==
// @name         JPDB anki export
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Export JPDB page to anki
// @match        https://jpdb.io/kanji/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// ==/UserScript==

;(function () {
  'use strict'

  const statusEl = createStatusUI()

  function ankiInvoke(action, params = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'http://localhost:8765',
        headers: {
          'Content-Type': 'application/json',
        },
        data: JSON.stringify({
          action,
          version: 6,
          params,
        }),
        onload: function (res) {
          try {
            const data = JSON.parse(res.responseText)
            if (data.error) {
              reject(new Error(data.error))
            } else {
              resolve(data.result)
            }
          } catch (e) {
            reject(e)
          }
        },
        onerror: function (err) {
          reject(err)
        },
      })
    })
  }

  function createStatusUI() {
    const el = document.createElement('div')
    el.id = '__jpdb_anki_status__'
    Object.assign(el.style, {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      zIndex: 999999,
      padding: '8px',
      borderRadius: '8px',
      color: '#fff',
      background: '#333',
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      width: '320px',
      opacity: '0',
      transition: 'opacity 0.15s ease',
    })
    document.body.appendChild(el)
    return el
  }

  function setStatus(type, message, timeout = 2000) {
    const colors = {
      progress: '#3b82f6',
      success: '#16a34a',
      error: '#dc2626',
    }

    statusEl.textContent = message
    statusEl.style.background = colors[type] || '#333'
    statusEl.style.opacity = '1'

    if (timeout) {
      clearTimeout(setStatus._t)
      setStatus._t = setTimeout(() => {
        statusEl.style.opacity = '0'
      }, timeout)
    }
  }

  async function runSort() {
    setStatus('progress', 'Sorting...')
    try {
      const noteIds = await ankiInvoke('findNotes', {
        query: '"note:JP Kanji"',
      })
      const notes = await ankiInvoke('notesInfo', { notes: noteIds })
      const cardIds = []
      for (const note of notes) {
        cardIds.push(note.cards[0])
      }
      const cards = await ankiInvoke('cardsInfo', { cards: cardIds })
      const byKanji = new Map()
      for (const n of notes) {
        const k = n.fields.Kanji.value.trim()
        const parts = Array.from(n.fields.Parts.value.trim())
        console.log(n)
        byKanji.set(k, {
          id: n.id,
          parts,
          card: n.cards[0],
        })
      }
      const visited = new Set()
      const temp = new Set()
      const result = []

      function visit(k) {
        if (visited.has(k) || temp.has(k)) {
          return
        }
        temp.add(k)
        const node = byKanji.get(k)
        if (node) {
          for (const p of node.parts) {
            if (byKanji.has(p)) {
              visit(p)
            }
          }
        }

        temp.delete(k)
        visited.add(k)
        result.push(k)
      }

      for (const k of byKanji.keys()) {
        visit(k)
      }
      for (let i = 0; i < result.length; i++) {
        setStatus('progress', `${i}/${result.length}`)
        console.log({
          card: result[i].card,
          keys: ['due'],
          newValues: [cards[i].due.toString()],
        })
        await ankiInvoke('setSpecificValueOfCard', {
          card: result[i].card,
          keys: ['due'],
          newValues: [cards[i].due.toString()],
        })
      }
      setStatus('success', `Repositioned ${noteIds.length}`)
    } catch (error) {
      setStatus('error', error.toString())
    }
  }

  async function run() {
    try {
      setStatus('progress', 'In Progress')
      const kanji = document.querySelector('#q')?.value.trim()
      if (!kanji) throw new Error('Empty input')
      const Parts = [
        ...document.querySelectorAll(
          '.hbox .subsection-composed-of-kanji .plain',
        ),
      ].map((x) => x.textContent.trim())
      let partAbsent = false
      for (let i = 0; i < Parts.length; i++) {
        const char = Parts[i]
        if (!(await ankiInvoke('findNotes', { query: `Kanji:${char}` }))[0]) {
          window.open(
            `https://jpdb.io/kanji/${encodeURIComponent(char)}#a`,
            '_blank',
          )
          partAbsent = true
        }
      }
      if (partAbsent) throw new Error('Add parts first')
      const id = (await ankiInvoke('findNotes', { query: `Kanji:${kanji}` }))[0]
      if (!id) throw new Error('Create with yomitan first.')
      await ankiInvoke('updateNoteFields', {
        note: {
          id,
          fields: {
            Parts: Parts.join(''),
            Mnemonic:
              document.querySelector('.mnemonic')?.textContent.trim() ?? '',
            Vocab: [...document.querySelectorAll('.subsection-used-in .plain')]
              .map((x) => {
                const c = x.cloneNode(true)
                c.querySelectorAll('rt, rp').forEach((x) => x.remove())
                return c.textContent.trim()
              })
              .join(', '),
          },
        },
      })
      setStatus('success', 'Successfully updated ' + id)
    } catch (err) {
      console.error(err)
      setStatus('error', err.toString())
    }
  }

  // Shift + A hotkey
  document.addEventListener('keydown', (e) => {
    if (e.shiftKey && e.key.toLowerCase() === 'a') {
      run()
    }
    if (e.shiftKey && e.key.toLowerCase() === 's') {
      runSort()
    }
  })
})()
