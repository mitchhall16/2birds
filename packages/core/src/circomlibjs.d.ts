declare module 'circomlibjs' {
  interface MimcSponge {
    F: {
      toObject(el: any): bigint;
    };
    multiHash(inputs: bigint[], key: number, nOutputs: number): any;
  }

  export function buildMimcSponge(): Promise<MimcSponge>;
}
