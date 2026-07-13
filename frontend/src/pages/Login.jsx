import React, { useContext, useEffect, useState } from "react";
import { ShopContext } from "../context/ShopContext";
import axios from "axios";
import { toast } from "react-toastify";
import { sentinelIdentify, sentinelTrack } from "../sentinel.js";

const Login = () => {
  const [currentState, setCurrentState] = useState("Login");
  const { token, setToken, navigate, backendUrl, triggerMfa } = useContext(ShopContext);

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");

  const onSubmitHandler = async (event) => {
    event.preventDefault();

    try {
      if (currentState === "Sign Up") {
        const response = await axios.post(backendUrl + "/api/user/register", {
          name,
          email,
          password,
        });
        // console.log(response.data);

        if (response.data.success) {
          const userToken = response.data.token;
          // Identify with Sentinel first
          sentinelIdentify(userToken, userToken);
          
          // Track sign up action
          const verdict = await sentinelTrack("signup", { email });
          
          if (verdict.recommended_action === "BLOCK" || verdict.recommended_action === "TERMINATE_SESSION") {
            toast.error("Registration blocked due to suspicious activity.");
            return;
          }

          if (verdict.recommended_action === "STEP_UP_AUTH") {
            triggerMfa(userToken, () => {
              setToken(userToken);
              localStorage.setItem("token", userToken);
            });
            return;
          }

          // ALLOW
          setToken(userToken);
          localStorage.setItem("token", userToken);
        } else {
          toast.error(response.data.message);
        }
      } else {
        const response = await axios.post(backendUrl + "/api/user/login", {
          email,
          password,
        });
        // console.log(response.data);

        if (response.data.success) {
          const userToken = response.data.token;
          // Identify with Sentinel first
          sentinelIdentify(userToken, userToken);

          // Track login action
          const verdict = await sentinelTrack("login", { email });

          if (verdict.recommended_action === "BLOCK" || verdict.recommended_action === "TERMINATE_SESSION") {
            toast.error("Login blocked due to suspicious activity.");
            return;
          }

          if (verdict.recommended_action === "STEP_UP_AUTH") {
            triggerMfa(userToken, () => {
              setToken(userToken);
              localStorage.setItem("token", userToken);
            });
            return;
          }

          // ALLOW
          setToken(userToken);
          localStorage.setItem("token", userToken);
        } else {
          toast.error(response.data.message);
        }
      }
    } catch (error) {
      console.log(error);
      toast.error(error.message);
    }
  };

  useEffect(() => {
    if (token) {
      navigate("/");
    }
  }, [token]);

  return (
    <form
      onSubmit={onSubmitHandler}
      className="flex flex-col items-center w-[90%] sm:max-w-96 m-auto mt-14 gap-4 text-gray-800"
    >
      <div className="inline-flex items-center gap-2 mb-2 mt-10">
        <p className="prata-regular text-3xl">{currentState}</p>
        <hr className="border-none h-[1.5px] w-8 bg-gray-800" />
      </div>
      {currentState === "Login" ? (
        ""
      ) : (
        <input
          onChange={(e) => setName(e.target.value)}
          value={name}
          type="text"
          className="w-full px-3 py-2 border border-gray-800"
          placeholder="Name"
          required
        />
      )}
      <input
        onChange={(e) => setEmail(e.target.value)}
        value={email}
        type="email"
        className="w-full px-3 py-2 border border-gray-800"
        placeholder="Email"
        required
        data-sentinel-field="email"
      />
      <input
        onChange={(e) => setPassword(e.target.value)}
        value={password}
        type="password"
        className="w-full px-3 py-2 border border-gray-800"
        placeholder="Password"
        required
        data-sentinel-field="password"
      />
      <div className="w-full flex justify-between text-sm mt-[-8px]">
        <p className="cursor-pointer">Forgot your password?</p>
        {currentState === "Login" ? (
          <p
            onClick={() => setCurrentState("Sign Up")}
            className="cursor-pointer"
          >
            Create account
          </p>
        ) : (
          <p
            onClick={() => setCurrentState("Login")}
            className="cursor-pointer"
          >
            Login Here
          </p>
        )}
      </div>
      <button className="bg-black text-white font-light px-8 py-2 mt-4">
        {currentState === "Login" ? "Sign In" : "Sign Up"}
      </button>
    </form>
  );
};

export default Login;
