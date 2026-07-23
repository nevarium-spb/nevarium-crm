import '@testing-library/jest-dom/vitest'

// Серверные тесты (@vitest-environment node) не имеют window — весь шим только для jsdom.
if (typeof window !== 'undefined') {
  // jsdom не реализует IntersectionObserver и matchMedia — нужны для framer-motion
  class IO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  if (!window.IntersectionObserver) {
    window.IntersectionObserver = IO
  }

  if (!window.matchMedia) {
    window.matchMedia = (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })
  }

  // jsdom определяет scrollTo, но бросает "Not implemented" — заменяем всегда
  window.scrollTo = () => {}
}
