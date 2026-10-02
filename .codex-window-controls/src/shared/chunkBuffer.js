// Bounded text buffer made of chunks: keeps roughly the last `max` characters.
// push() is O(1); whole chunks are dropped from the front when over the limit,
// and only the oldest chunk is ever cut. text() joins on demand.
export class ChunkBuffer {
  constructor(max) {
    this.max = max
    this.chunks = []
    this.length = 0
  }

  push(data) {
    if (!data) return
    this.chunks.push(data)
    this.length += data.length
    this.trim()
  }

  unshift(data) {
    if (!data) return
    this.chunks.unshift(data)
    this.length += data.length
    this.trim()
  }

  trim() {
    while (this.length > this.max && this.chunks.length > 1) {
      const first = this.chunks[0]
      const excess = this.length - this.max
      if (first.length <= excess) {
        this.chunks.shift()
        this.length -= first.length
      } else {
        this.chunks[0] = first.slice(excess)
        this.length -= excess
      }
    }
    if (this.length > this.max && this.chunks.length === 1) {
      this.chunks[0] = this.chunks[0].slice(this.length - this.max)
      this.length = this.chunks[0].length
    }
  }

  text() {
    if (this.chunks.length > 1) {
      // Compact so repeated reads stay cheap.
      this.chunks = [this.chunks.join('')]
    }
    return this.chunks[0] || ''
  }
}
