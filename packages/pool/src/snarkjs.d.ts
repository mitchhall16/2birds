declare module 'snarkjs' {
  export namespace groth16 {
    function fullProve(input: any, wasmPath: string, zkeyPath: string): Promise<{ proof: any; publicSignals: string[] }>;
    function verify(vkey: any, publicSignals: string[], proof: any): Promise<boolean>;
  }
  export namespace plonk {
    function fullProve(input: any, wasmPath: string, zkeyPath: string): Promise<{ proof: any; publicSignals: string[] }>;
    function verify(vkey: any, publicSignals: string[], proof: any): Promise<boolean>;
  }
}
