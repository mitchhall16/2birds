FROM node:20-bookworm

# Install Rust toolchain for circom
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Install circom from source (v2.1.6)
RUN cargo install --git https://github.com/iden3/circom.git --tag v2.1.6

# Install snarkjs globally
RUN npm install -g snarkjs@0.7.4

# Install circomlib for circuit imports
RUN mkdir -p /app && cd /app && npm init -y && npm install circomlib@2.0.5

WORKDIR /circuits

# Usage:
#   docker build -t privacy-circuits -f circuits/Dockerfile .
#   docker run -v $(pwd)/circuits:/circuits -v $(pwd)/node_modules:/circuits/../node_modules privacy-circuits [withdraw|range-proof|shielded|all]
ENTRYPOINT ["bash", "build.sh"]
CMD ["all"]
