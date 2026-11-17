declare module '*.txt' {
  const text: string;
  export default text;
}

declare module '*.bin' {
  const data: ArrayBuffer;
  export default data;
}
