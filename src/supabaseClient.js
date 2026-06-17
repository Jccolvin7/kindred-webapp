// src/supabaseClient.js
//
// This file connects your React app to your Supabase database.
// It reads the URL and key from environment variables so they're
// never hardcoded directly into your code.

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseKey);
