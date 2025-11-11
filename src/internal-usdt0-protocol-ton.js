// Copyright 2024 Tether Operations Limited
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
'use strict'

import { BridgeProtocol } from '@tetherto/wdk-wallet/protocols'

import { WalletAccountTon } from '@tetherto/wdk-wallet-ton'

import { Coin, CurrencyAmount, Token } from '@wdk-ton-packages/ui-core'
import { parseTonAddress } from '@wdk-ton-packages/ui-ton'
import { createOftBridgeConfig } from '@wdk-ton-packages/ui-bridge-oft'

// eslint-disable-next-line camelcase
import { OftBridgeApiFactory__ton } from '@wdk-ton-packages/ui-bridge-oft/ton'

import { Cell, internal, toNano } from '@ton/ton'

import OFT_TOKEN_CONFIG from './data/oft-token-config.js'

const BRIDGE_FEE_BASIS_POINTS = 10n

const DENOMINATOR_BASIS_POINTS = 10_000n

const DUMMY_MESSAGE_VALUE = toNano(0.8)

const BRIDGE_ADDRESS_CONFIG = {
  oftProxy: '0x1ddf580052174ed1dd0d66c35bfdc1a5fcc69af4f4ae36154b13dcfc6c14a35f',
  controller: '0x1eb2bbea3d8c0d42ff7fd60f0264c866c934bbff727526ca759e7374cae0c166',
  ulnManager: '0x06b52b11abaf65bf1ff47c57e890ba4ad6a75a68859bbe5a51c1fc451954c54c',
  token: '0xb113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe',
  executor: '0x0f9a60ea29c5c9e4643601e8881e850498ee680a413e8ba01d5e55ce1c221024'
}

const BRIDGE_ULN_CONFIGS = {
  USDT_TON_ETHEREUM: {
    confirmations: '2',
    confirmationsNull: false,
    executor: '0x0',
    executorNull: true,
    maxMessageBytes: '522',
    optionalDVNs: [],
    optionalDVNsNull: false,
    requiredDVNs: ['0xd122dec4ec8bd66c68344faf0dd471d727a7d57a21b62051705bbe2e4c272a7', '0x4b9f9836004d7f53e52e01602d9c07c14cdf38b8a946b6e813cfea8de10927d'],
    requiredDVNsNull: false,
    workerQuoteGasLimit: '120000'
  },
  USDT_TON_ARBITRUM: {
    confirmations: '2',
    confirmationsNull: false,
    executor: '0x0',
    executorNull: true,
    maxMessageBytes: '522',
    optionalDVNs: [],
    optionalDVNsNull: false,
    requiredDVNs: ['0xd122dec4ec8bd66c68344faf0dd471d727a7d57a21b62051705bbe2e4c272a7', '0x4b9f9836004d7f53e52e01602d9c07c14cdf38b8a946b6e813cfea8de10927d'],
    requiredDVNsNull: false,
    workerQuoteGasLimit: '120000'
  }
}

export default class InternalUsdt0ProtocolTon extends BridgeProtocol {
  async bridge ({ targetChain, recipient, token, amount, oft }) {
    if (!(this._account instanceof WalletAccountTon)) {
      throw new Error("The 'bridge(options)' method requires the protocol to be initialized with a non read-only account.")
    }

    if (!this._account._tonClient) {
      throw new Error('The wallet must be connected to ton center in order to perform bridge operations.')
    }

    const txParams = await this._getBridgeTxParams({ targetChain, recipient, token, amount, oft })

    const message = internal(txParams)

    const transfer = await this._account._getTransfer(message)
    const fee = await this._account._getTransferFee(transfer)
    const bridgeFee = this._getContractFee(amount)

    if (this._config.bridgeMaxFee !== undefined && fee + bridgeFee >= this._config.bridgeMaxFee) {
      throw new Error('The bridge operation exceeds the bridge max fee.')
    }

    await this._account._contract.send(transfer)

    return {
      hash: transfer.hash().toString('hex'),
      fee,
      bridgeFee
    }
  }

  async quoteBridge ({ targetChain, recipient, token, amount, oft }) {
    if (!this._account._tonClient) {
      throw new Error('The wallet must be connected to ton center in order to quote bridge operations.')
    }

    const txParams = await this._getBridgeTxParams({ targetChain, recipient, token, amount, oft })

    const message = internal(txParams)

    const transfer = await this._account._getTransfer(message)
    const fee = await this._account._getTransferFee(transfer)
    const bridgeFee = this._getContractFee(amount)

    return {
      fee,
      bridgeFee
    }
  }

  async _getBridgeTxParams ({ targetChain, recipient, token, amount, oft }) {
    if (targetChain === 'ton') {
      throw new Error('The target chain cannot be equal to the source chain (ton).')
    }

    if (!oft) {
      if (!OFT_TOKEN_CONFIG[token]) {
        throw new Error(`Token '${token}' is not natively supported. Provide a custom oft configuration to bridge this token.`)
      }

      oft = OFT_TOKEN_CONFIG[token]
    }

    if (!oft.deployments[targetChain]) {
      throw new Error(`Target chain '${targetChain}' not supported.`)
    }

    const jettonWalletAddress = await this._account._getJettonWalletAddress(token)

    const oftBridgeConfig = createOftBridgeConfig(oft)

    const input = await this._getTransferInput({ targetChain, recipient, amount, oftBridgeConfig })

    const bridgeHelperFactory = new OftBridgeApiFactory__ton(
      this._account._tonClient,
      BRIDGE_ADDRESS_CONFIG,
      BRIDGE_ULN_CONFIGS
    )

    const bridgeHelper = bridgeHelperFactory.create(oftBridgeConfig)
    const { nativeFee } = await bridgeHelper.getMessageFee(input)

    const transfer = await bridgeHelper.transfer({ ...input, fee: { nativeFee } })
    const data = await transfer.unwrap()
    const boc = data.messages[0].payload.toBoc()

    const body = Cell.fromBoc(boc)[0]

    return {
      to: jettonWalletAddress,
      value: DUMMY_MESSAGE_VALUE,
      body
    }
  }

  async _getTransferInput ({ targetChain, recipient, amount, oftBridgeConfig }) {
    const address = await this._account.getAddress()

    const dstAddress = parseTonAddress(recipient).toRawString()
      .replace(':', 'x')

    const srcAmount = CurrencyAmount.fromRawAmount(
      Token.from({ chainKey: 'ton', decimals: oftBridgeConfig.sharedDecimals }),
      amount
    )

    const dstAmountMin = CurrencyAmount.fromRawAmount(
      Token.from({ chainKey: targetChain, decimals: oftBridgeConfig.sharedDecimals }),
      BigInt(amount) - this._getContractFee(amount)
    )

    const dstNativeAmount = CurrencyAmount.fromRawAmount(
      Coin.from({ chainKey: targetChain, decimals: 0 }),
      0
    )

    return {
      srcChainKey: 'ton',
      dstChainKey: targetChain,
      srcToken: { chainKey: 'ton' },
      dstToken: { chainKey: targetChain },
      srcAddress: address,
      dstAddress,
      srcAmount,
      dstAmountMin,
      dstNativeAmount
    }
  }

  _getContractFee (amount) {
    amount = BigInt(amount)

    return amount * BRIDGE_FEE_BASIS_POINTS / DENOMINATOR_BASIS_POINTS
  }
}
