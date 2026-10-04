export function textResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

export function errorResult(error: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: error instanceof Error ? error.message : String(error)
      }
    ],
    isError: true
  };
}
