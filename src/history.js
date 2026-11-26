// Images and Files stay shared. Only editable data is copied into history.
export function copyEditor(editor) {
  return {
    ...structuredClone({ ...editor, pages: undefined }),
    pages: editor.pages.map(({ image, file, url, ...data }) => ({
      ...structuredClone(data), image, file, url,
    })),
  }
}

export class EditHistory {
  constructor(limit = 40) {
    this.limit = limit
    this.past = []
    this.future = []
  }

  record(editor) {
    this.past.push(copyEditor(editor))
    if (this.past.length > this.limit) this.past.shift()
    this.future = []
  }

  undo(editor) {
    if (!this.past.length) return null
    this.future.push(copyEditor(editor))
    return this.past.pop()
  }

  redo(editor) {
    if (!this.future.length) return null
    this.past.push(copyEditor(editor))
    return this.future.pop()
  }

  clear() {
    this.past = []
    this.future = []
  }
}
