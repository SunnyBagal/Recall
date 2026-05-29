import { useState } from "react";
import { Button } from "../components/Button";
import { LogoIcon } from "../icons/LogoIcon";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";

export function Signup() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const navigate = useNavigate();

  async function signup() {
    try {
      await api.post("/api/v1/signup", { username: name, email, password });
      navigate("/signin");
    } catch (e) {
      alert("Signup failed. Please try again.");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="text-white"><LogoIcon size="xl" /></div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-white">Create your Recall account</h1>
          <p className="mt-1 text-sm text-gray-500">Your second brain, one link at a time.</p>
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); signup(); }}
          className="bg-white border border-gray-200 rounded-2xl p-8 shadow-sm flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="name" className="text-sm font-medium text-gray-700">Name</label>
            <input
              id="name" type="text" value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your Name"
              className="px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 text-sm placeholder:text-gray-400 focus:outline-none focus:border-black focus:bg-white transition"
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="email" className="text-sm font-medium text-gray-700">Email</label>
            <input
              id="email" type="email" value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 text-sm placeholder:text-gray-400 focus:outline-none focus:border-black focus:bg-white transition"
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="password" className="text-sm font-medium text-gray-700">Password</label>
            <input
              id="password" type="password" value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              className="px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 text-sm placeholder:text-gray-400 focus:outline-none focus:border-black focus:bg-white transition"
              required minLength={8}
            />
          </div>

          <Button variant="primary" size="md" text="Sign up" type="submit" className="w-full mt-2" />

          <p className="text-center text-sm text-gray-500 mt-2">
            Already have an account?{" "}
            <a href="/signin" className="text-black font-medium hover:underline">Sign in</a>
          </p>
        </form>
      </div>
    </div>
  );
}

export default Signup;