import React, { useState, useEffect } from "react";
import { WalletOutlined, CheckCircleOutlined, LoadingOutlined } from "@ant-design/icons";
import axios from "axios";
import { API_BASE } from "../config/api";
import { authHeaders } from "../config/auth";

interface WalletData {
  id: string;
  userId: string;
  balance: number;
  createdAt: string;
  updatedAt: string;
}

interface WalletTransaction {
  id: string;
  eventId: string;
  type: string;
  amount: number;
  reason: string;
  status: string;
  createdAt: string;
}

interface RazorpayConfig {
  configured: boolean;
  keyId?: string;
}

interface PaymentDemoProps {
  /** The signed-in user; the API derives ownership from the token, not this prop */
  currentUserId: string;
}

const PaymentDemo: React.FC<PaymentDemoProps> = ({ currentUserId }) => {
  const userAuth = () => ({ headers: authHeaders("user") });
  const [loading, setLoading] = useState(false);
  const [creatingWallet, setCreatingWallet] = useState(false);
  const [walletData, setWalletData] = useState<WalletData | null>(null);
  const [walletTransactions, setWalletTransactions] = useState<WalletTransaction[]>([]);
  const [orderInfo, setOrderInfo] = useState<any>(null);
  const [paymentVerification, setPaymentVerification] = useState<any>(null);
  const [razorpayConfig, setRazorpayConfig] = useState<RazorpayConfig | null>(null);
  const [razorpayLoaded, setRazorpayLoaded] = useState(false);
  const [processingState, setProcessingState] = useState<string>("");
  const [amount, setAmount] = useState("500");
  const [description, setDescription] = useState("Event ticket purchase");

  const loadRazorpayConfig = async () => {
    try {
      const response = await axios.get(`${API_BASE}/api/payments/config`);
      setRazorpayConfig(response.data);
      if (response.data.configured && response.data.keyId) {
        loadRazorpayScript(response.data.keyId);
      }
    } catch {
      setRazorpayConfig({ configured: false });
    }
  };

  const loadRazorpayScript = (keyId: string) => {
    if ((window as any).Razorpay) {
      setRazorpayLoaded(true);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => setRazorpayLoaded(true);
    script.onerror = () => setRazorpayLoaded(false);
    document.body.appendChild(script);
  };

  const loadWalletData = async () => {
    try {
      const res = await axios.get(`${API_BASE}/api/wallets/${currentUserId}`, userAuth());
      if (res.data.success) {
        setWalletData(res.data.wallet);
        const txRes = await axios.get(`${API_BASE}/api/wallets/${currentUserId}/transactions`, userAuth());
        if (txRes.data.success) setWalletTransactions(txRes.data.transactions);
      }
    } catch {
      setWalletData(null);
    }
  };

  useEffect(() => {
    loadRazorpayConfig();
    loadWalletData();
  }, [currentUserId]);

  const createWallet = async () => {
    setCreatingWallet(true);
    try {
      const res = await axios.post(`${API_BASE}/api/wallets`, {}, userAuth());
      if (res.data.success) {
        loadWalletData();
      }
    } catch (e: any) {
      console.error("Wallet creation failed", e);
    } finally {
      setCreatingWallet(false);
    }
  };

  const createPaymentOrder = async () => {
    setLoading(true);
    try {
      const res = await axios.post(
        `${API_BASE}/api/payments/create-order`,
        {
          amount: parseFloat(amount),
          description: description || `Payment of ₹${amount}`,
        },
        userAuth()
      );
      if (res.data.success) {
        // Use the API response directly — React setState is async; do not open checkout on stale orderInfo.
        const newOrder = res.data.order;
        setOrderInfo(newOrder);
        setPaymentVerification(null);
        if (razorpayConfig?.keyId && (window as any).Razorpay) {
          openRazorpayCheckout(newOrder);
        }
      }
    } catch (e: any) {
      console.error("Order creation failed", e);
    } finally {
      setLoading(false);
    }
  };

  const openRazorpayCheckout = async (orderOverride?: any) => {
    const order = orderOverride ?? orderInfo;
    if (!order?.orderId || !razorpayConfig?.keyId) return;
    if (!(window as any).Razorpay) return;
    setLoading(true);
    setProcessingState("Opening Razorpay Checkout...");
    try {
      const razorpay = new (window as any).Razorpay({
        key: razorpayConfig.keyId,
        name: "EventGuard",
        description: order.notes?.description || "Payment for EventGuard",
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        prefill: { name: "Test User", email: "test@example.com" },
        theme: { color: "#7c3aed" },
        config: {
          blocks: {
            card: { show: true },
            wallet: { show: true },
            netbanking: { show: true },
          },
        },
        handler: async (response: any) => {
          setProcessingState("Verifying payment...");
          await verifyRealPayment(response, order);
        },
      });
      razorpay.open();
    } catch (e: any) {
      console.error("Checkout error", e);
    } finally {
      setProcessingState("");
      setLoading(false);
    }
  };

  const verifyRealPayment = async (razorpayResponse: any, orderOverride?: any) => {
    const order = orderOverride ?? orderInfo;
    if (!order?.orderId) {
      console.error("Verification failed: missing orderId");
      return;
    }
    try {
      const res = await axios.post(
        `${API_BASE}/api/payments/verify`,
        {
          orderId: order.orderId,
          paymentId: razorpayResponse.razorpay_payment_id,
          signature: razorpayResponse.razorpay_signature,
        },
        userAuth()
      );
      if (res.data.success) {
        setPaymentVerification(res.data);
        setTimeout(() => loadWalletData(), 2000);
      }
    } catch (e: any) {
      console.error("Verification failed", e);
    } finally {
      setLoading(false);
      setProcessingState("");
    }
  };

  return (
    <div className="card">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <h2 className="text-2xl font-semibold text-accent-gold">Payment Demo</h2>
          <span className="px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide rounded bg-amber-900/40 text-amber-300 border border-amber-800/60">TEST MODE</span>
        </div>
        <p className="text-sm text-text-secondary">Test Razorpay payments safely. No real money is charged.</p>
      </div>

      {/* User / Wallet */}
      <div className="mb-6 p-4 bg-dark-card rounded-xl border border-dark-border">
        <div className="text-xs uppercase tracking-wider text-text-secondary mb-3">Current User</div>
        <div className="font-mono text-sm text-text-primary mb-4">{currentUserId}</div>

        <div className="text-xs uppercase tracking-wider text-text-secondary mb-3">Wallet Status</div>
        {!walletData ? (
          <div className="flex items-center gap-4">
            <span className="text-sm text-red-400">No wallet found</span>
            <button
              onClick={createWallet}
              disabled={creatingWallet}
              className="px-4 py-2 bg-accent-gold text-dark-bg text-sm font-medium rounded-lg hover:bg-accent-muted disabled:opacity-50 transition-colors"
            >
              {creatingWallet ? "Creating..." : "Create Wallet"}
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div>
              <div className="text-2xl font-bold text-text-primary">₹{walletData.balance.toFixed(2)}</div>
              <div className="text-xs text-green-400 mt-1">Active · Wallet Ready</div>
            </div>
            <button
              onClick={loadWalletData}
              className="text-xs px-3 py-1.5 border border-dark-border rounded-md text-text-secondary hover:text-text-primary hover:border-accent-gold transition-colors"
            >
              Refresh
            </button>
          </div>
        )}
        {walletTransactions.length > 0 && (
          <div className="mt-4 pt-4 border-t border-dark-border text-xs">
            <div className="text-text-secondary mb-2">Recent Transactions</div>
            <div className="space-y-1.5">
              {walletTransactions.slice(0, 3).map((tx) => (
                <div key={tx.id} className="flex justify-between text-sm">
                  <span className={tx.type === "CREDIT" ? "text-green-400" : "text-red-400"}>
                    {tx.type === "CREDIT" ? "+" : "-"}₹{tx.amount.toFixed(2)}
                  </span>
                  <span className="text-text-secondary">{tx.reason}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Create Order */}
      <div className="mb-6 p-4 bg-dark-card rounded-xl border border-dark-border">
        <h3 className="text-lg font-semibold text-text-primary mb-4">Create Payment Order</h3>
        <div className="space-y-3">
          <div>
            <label htmlFor="amount" className="block text-xs font-medium text-text-secondary mb-1">Amount (INR)</label>
            <div className="flex items-center gap-2">
              <span className="text-text-secondary">₹</span>
              <div className="relative">
                <input
                  id="amount"
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full pl-3 pr-[68px] py-2 bg-dark-bg border border-dark-border rounded-lg text-text-primary focus:outline-none focus:border-accent-gold text-sm appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  placeholder="500"
                />
                <div className="absolute right-0 top-0 bottom-0 flex flex-col w-[34px] bg-[#18122b] border-l border-dark-border rounded-r-lg overflow-hidden">
                  <button
                    type="button"
                    aria-label="Increase amount"
                    onClick={() => setAmount((prev) => String(Math.max(0, parseInt(prev || "0") + 1)))}
                    className="flex-1 flex items-center justify-center text-amber-300 hover:text-amber-200 hover:bg-amber-900/20 transition-colors text-xs leading-none"
                    tabIndex={-1}
                  >
                    <svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 5 L5 1 L9 5"/></svg>
                  </button>
                  <div className="h-px bg-dark-border" />
                  <button
                    type="button"
                    aria-label="Decrease amount"
                    onClick={() => setAmount((prev) => String(Math.max(0, parseInt(prev || "0") - 1)))}
                    className="flex-1 flex items-center justify-center text-amber-300 hover:text-amber-200 hover:bg-amber-900/20 transition-colors text-xs leading-none"
                    tabIndex={-1}
                  >
                    <svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 1 L5 5 L9 1"/></svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div>
            <label htmlFor="desc" className="block text-xs font-medium text-text-secondary mb-1">Description</label>
            <input
              id="desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 bg-dark-bg border border-dark-border rounded-lg text-text-primary focus:outline-none focus:border-accent-gold text-sm"
              placeholder="Event ticket purchase"
            />
          </div>
          <button
            onClick={createPaymentOrder}
            disabled={loading || !walletData}
            className="w-full px-4 py-2.5 bg-accent-gold text-dark-bg font-medium rounded-lg hover:bg-opacity-90 disabled:opacity-50 transition-colors text-sm"
          >
            {loading ? "Creating..." : "Create Payment Order & Pay"}
          </button>
        </div>
      </div>

      {/* Order + Checkout */}
      {orderInfo && (
        <div className="mb-6 p-4 bg-blue-950/20 border border-blue-900/40 rounded-xl">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-2 h-2 rounded-full bg-blue-400" />
            <h3 className="font-semibold text-blue-200">Order Created</h3>
          </div>
          <div className="text-sm space-y-1 text-text-secondary mb-3">
            <div><span className="text-text-secondary">Order ID:</span> <span className="font-mono text-text-primary">{orderInfo.orderId}</span></div>
            <div><span className="text-text-secondary">Amount:</span> <span className="text-text-primary">₹{(orderInfo.amount / 100).toFixed(2)}</span></div>
            <div><span className="text-text-secondary">Currency:</span> <span className="text-text-primary">{orderInfo.currency || "INR"}</span></div>
            <div><span className="text-text-secondary">Status:</span> <span className="text-blue-300">CREATED</span></div>
          </div>
          {!razorpayConfig?.configured ? (
            <div className="text-xs text-amber-300">Razorpay not configured — checkout unavailable.</div>
          ) : !razorpayLoaded ? (
            <button disabled className="px-4 py-2 bg-blue-900/60 text-blue-200 rounded-lg text-sm font-medium">Loading Razorpay...</button>
          ) : (
            <>
              <button
                onClick={openRazorpayCheckout}
                disabled={loading}
                className="px-4 py-2 bg-violet-600 text-white rounded-lg text-sm font-medium hover:bg-violet-700 disabled:opacity-50 transition-colors"
              >
                Pay with Razorpay Test Mode
              </button>
              {processingState && (
                <div className="text-xs text-text-secondary mt-2">{processingState}</div>
              )}
              <div className="text-[11px] text-text-secondary mt-2">Test card: 4111 1111 1111 1111 · Any future expiry · CVV 123</div>
            </>
          )}
        </div>
      )}

      {/* Verification */}
      {paymentVerification && (
        <div className="mb-6 p-4 bg-green-950/20 border border-green-900/40 rounded-xl">
          <div className="flex items-center gap-2 mb-3">
            <CheckCircleOutlined className="text-green-400" />
            <h3 className="font-semibold text-green-200">Payment Verified</h3>
          </div>
          <div className="text-sm space-y-1 text-text-secondary mb-3">
            <div><span className="text-text-secondary">Status:</span> <span className="text-green-300 font-medium">VERIFIED</span></div>
            <div><span className="text-text-secondary">Event:</span> <span className="font-mono text-text-primary">{paymentVerification.event?.eventId}</span></div>
            <div><span className="text-text-secondary">Type:</span> <span className="text-text-primary">{paymentVerification.event?.eventType}</span></div>
            <div><span className="text-text-secondary">Amount:</span> <span className="text-text-primary">₹{paymentVerification.event?.amount}</span></div>
          </div>
          <p className="text-xs text-text-secondary">PAYMENT_SUCCESS queued → Outbox → Kafka → Worker → Idempotency → Wallet credit.</p>
        </div>
      )}

      {/* Pipeline */}
      <div className="p-4 bg-dark-card rounded-xl border border-dark-border">
        <h3 className="text-base font-semibold text-text-primary mb-4">How EventGuard Processes Payments</h3>
        <div className="grid grid-cols-5 gap-2 text-xs">
          {[
            { n: 1, t: "Payment verified", sub: "Razorpay + HMAC" },
            { n: 2, t: "PAYMENT_SUCCESS event", sub: "Created in DB" },
            { n: 3, t: "Transactional Outbox", sub: "Queued to publish" },
            { n: 4, t: "Kafka", sub: "Delivered to worker" },
            { n: 5, t: "Idempotency + Wallet", sub: "Atomic credit" },
          ].map((step) => (
            <div key={step.n} className="p-2 bg-dark-bg rounded-lg border border-dark-border text-center">
              <div className="w-6 h-6 mx-auto mb-1 rounded-full bg-violet-900 text-violet-300 flex items-center justify-center text-xs font-bold">{step.n}</div>
              <div className="font-medium text-text-primary leading-tight">{step.t}</div>
              <div className="text-[10px] text-text-secondary mt-0.5">{step.sub}</div>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-center gap-1 mt-2 text-text-secondary text-xs">
          <span>Razorpay</span><span>→</span><span>EventGuard</span><span>→</span><span>Kafka</span><span>→</span><span>Idempotency</span><span>→</span><span>PostgreSQL</span><span>→</span><span>Wallet</span>
        </div>
      </div>
    </div>
  );
};

export default PaymentDemo;
