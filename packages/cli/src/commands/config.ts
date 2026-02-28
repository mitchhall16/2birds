/**
 * CLI commands for configuration management
 */

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import { getConfigPath, defaultConfig } from '../utils.js';

export function configCommands(): Command {
  const config = new Command('config')
    .description('Configuration management');

  config
    .command('init')
    .description('Initialize configuration file')
    .option('-n, --network <net>', 'Network: mainnet, testnet, localnet', 'testnet')
    .action(async (opts: { network: string }) => {
      const configPath = getConfigPath();
      if (fs.existsSync(configPath)) {
        console.log(chalk.yellow(`Config already exists at ${configPath}`));
        console.log('Delete it first if you want to reinitialize.');
        return;
      }

      const cfg = { ...defaultConfig };
      if (opts.network === 'mainnet') {
        cfg.network.algodUrl = 'https://mainnet-api.algonode.cloud';
        cfg.network.indexerUrl = 'https://mainnet-idx.algonode.cloud';
        cfg.network.network = 'mainnet';
      } else if (opts.network === 'localnet') {
        cfg.network.algodUrl = 'http://localhost:4001';
        cfg.network.algodToken = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        cfg.network.indexerUrl = 'http://localhost:8980';
        cfg.network.network = 'localnet';
      }

      const dir = require('path').dirname(configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');
      console.log(chalk.green(`Config initialized at ${configPath}`));
      console.log(`Network: ${opts.network}`);
      console.log('\nEdit the config file to set contract app IDs and circuit paths.');
    });

  config
    .command('show')
    .description('Show current configuration')
    .action(() => {
      const configPath = getConfigPath();
      if (!fs.existsSync(configPath)) {
        console.log(chalk.red('No config found. Run: algo-privacy config init'));
        return;
      }

      const data = fs.readFileSync(configPath, 'utf-8');
      console.log(chalk.bold('Current configuration:\n'));
      console.log(data);
    });

  config
    .command('set')
    .description('Set a configuration value')
    .argument('<key>', 'Config key (dot notation, e.g., network.algodUrl)')
    .argument('<value>', 'Config value')
    .action((key: string, value: string) => {
      const configPath = getConfigPath();
      if (!fs.existsSync(configPath)) {
        console.log(chalk.red('No config found. Run: algo-privacy config init'));
        return;
      }

      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const keys = key.split('.');
      let obj = data;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!(keys[i] in obj)) obj[keys[i]] = {};
        obj = obj[keys[i]];
      }
      obj[keys[keys.length - 1]] = value;

      fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
      console.log(chalk.green(`Set ${key} = ${value}`));
    });

  return config;
}
