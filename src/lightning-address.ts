import fetch from 'cross-fetch';
import { parseKeysendResponse } from './utils/keysend';
import { isUrl, isValidAmount, parseLnUrlPayResponse } from './utils/lnurl';
import Invoice from './invoice';
import { InvoiceArgs, RequestInvoiceArgs, ZapArgs, ZapOptions } from './types';
import { generateZapEvent } from './utils/nostr';
import type { Boost } from './podcasting2/boostagrams';
import { boost as booster } from './podcasting2/boostagrams';
import { WebLNProvider, SendPaymentResponse } from "@webbtc/webln-types";

const LN_ADDRESS_REGEX =
  /^((?:[^<>()\[\]\\.,;:\s@"]+(?:\.[^<>()\[\]\\.,;:\s@"]+)*)|(?:".+"))@((?:\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(?:(?:[a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/

const DEFAULT_PROXY = "https://lnaddressproxy.getalby.com";

type LightningAddressOptions = {
  proxy?: string | false;
  webln?: WebLNProvider;
}

export default class LightningAddress {
  address: string;
  options: LightningAddressOptions;
  username: string | undefined;
  domain: string | undefined;
  pubkey: string | undefined;
  lnurlpData: Record<string, any>;
  keysendData: Record<string, any>;
  nostrData: Record<string, any>;
  nostrPubkey: string | undefined;
  nostrRelays: string[] | undefined;
  webln: WebLNProvider | undefined;

  constructor(address: string, options?: LightningAddressOptions) {
    this.address = address;
    this.options = { proxy: DEFAULT_PROXY, webln: globalThis.webln };
    this.options = Object.assign(this.options, options);
    this.parse();
    this.lnurlpData = {};
    this.keysendData = {};
    this.nostrData = [];
    this.webln = this.options.webln;
  }

  parse() {
    const result = LN_ADDRESS_REGEX.exec(this.address.toLowerCase());
    if (result) {
      this.username = result[1];
      this.domain = result[2];
    }
  }

  async fetch() {
    if (this.options.proxy) {
      return this.fetchWithProxy();
    } else {
      return this.fetchWithoutProxy();
    }
  }

  async fetchWithProxy() {
    const result = await fetch(`${this.options.proxy}/lightning-address-details?${new URLSearchParams({ ln: this.address }).toString()}`);
    const json = await result.json();
    this.lnurlpData = parseLnUrlPayResponse(json.lnurlp);
    this.keysendData = parseKeysendResponse(json.keysend);
    this.nostrData = json.nostr;
    if (this.username) {
      this.nostrPubkey = this.nostrData.names?.[this.username];
      this.nostrRelays = this.nostrPubkey ? this.nostrData.relays?.[this.nostrPubkey] : undefined;
    }
  }

  async fetchWithoutProxy() {
    if (!this.domain || !this.username) {
      return;
    }
    try {
      const lnurlResult = await fetch(this.lnurlpUrl());
      this.lnurlpData = parseLnUrlPayResponse(await lnurlResult.json());
    } catch (e) {
    }
    try {
      const keysendResult = await fetch(this.keysendUrl());
      this.keysendData = parseKeysendResponse(await keysendResult.json());
    } catch (e) {
    }
    try {
      const nostrResult = await fetch(this.nostrUrl());
      const data = await nostrResult.json();
      this.nostrData = data;
      this.nostrPubkey = this.nostrData.names?.[this.username];
      this.nostrRelays = this.nostrPubkey ? this.nostrData.relays?.[this.nostrPubkey] : undefined;
    } catch (e) {
    }
  }

  lnurlpUrl() {
    return `https://${this.domain}/.well-known/lnurlp/${this.username}`;
  }

  keysendUrl() {
    return `https://${this.domain}/.well-known/keysend/${this.username}`;
  }

  nostrUrl() {
    return `https://${this.domain}/.well-known/nostr.json?name=${this.username}`;
  }

  async generateInvoice(params: Record<string, string>): Promise<Invoice> {
    let data;
    if (this.options.proxy) {
      const invoiceResult = await fetch(`${this.options.proxy}/generate-invoice?${new URLSearchParams({ ln: this.address, ...params }).toString()}`);
      const json = await invoiceResult.json();
      data = json.invoice;
    } else {
      if (!this.lnurlpData.callback || !isUrl(this.lnurlpData.callback)) throw new Error('Valid callback does not exist in lnurlpData')
      const callbackUrl = new URL(this.lnurlpData.callback)
      callbackUrl.search = new URLSearchParams(params).toString()
      const invoiceResult = await fetch(callbackUrl);
      data = await invoiceResult.json();
    }

    const paymentRequest = data && data.pr && data.pr.toString();
    if (!paymentRequest) throw new Error('Invalid pay service invoice')

    const invoiceArgs: InvoiceArgs = { pr: paymentRequest };
    if (data && data.verify) invoiceArgs.verify = data.verify.toString();

    return new Invoice(invoiceArgs);
  }

  async requestInvoice(args: RequestInvoiceArgs): Promise<Invoice> {
    const msat = args.satoshi * 1000;
    const { commentAllowed, min, max } = this.lnurlpData;

    if (!isValidAmount({ amount: msat, min, max }))
      throw new Error('Invalid amount')
    if (args.comment && commentAllowed > 0 && args.comment.length > commentAllowed)
      throw new Error(
        `The comment length must be ${commentAllowed} characters or fewer`
      )

    const invoiceParams: { amount: string, comment?: string } = { amount: msat.toString() };
    if (args.comment) invoiceParams.comment = args.comment

    return this.generateInvoice(invoiceParams);
  }

  async boost(boost: Boost, amount: number = 0) {
    const { destination, customKey, customValue } = this.keysendData;
    return booster({
      destination,
      customKey,
      customValue,
      amount,
      boost,
    }, {
      webln: this.webln,
    })
  }

  async zapInvoice({
    satoshi, comment, relays, e
  }: ZapArgs, options: ZapOptions = {}): Promise<Invoice> {
    if (!this.nostrPubkey) {
      throw new Error("Nostr Pubkey is missing");
    }
    const p = this.nostrPubkey;
    const msat = satoshi * 1000;
    const { allowsNostr, min, max } = this.lnurlpData;

    if (!isValidAmount({ amount: msat, min, max }))
      throw new Error('Invalid amount')
    if (!allowsNostr) throw new Error('Your provider does not support zaps')

    const event = await generateZapEvent({
      satoshi: msat, comment, p, e, relays
    }, options);
    const zapParams: { amount: string, nostr: string } = {
      amount: msat.toString(),
      nostr: JSON.stringify(event)
    };

    const invoice = await this.generateInvoice(zapParams);
    return invoice;
  }

  async zap(args: ZapArgs, options: ZapOptions = {}): Promise<SendPaymentResponse> {
    const invoice = this.zapInvoice(args, options);
    if (!this.webln) {
      // mainly for TS
      throw new Error("WebLN not available");
    }
    await this.webln.enable();
    const response = this.webln.sendPayment((await invoice).paymentRequest);
    return response;
  }
}
