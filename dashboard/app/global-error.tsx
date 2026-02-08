'use client';

export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    return (
        <html>
            <body>
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: '100vh',
                    padding: '2rem',
                    textAlign: 'center',
                    backgroundColor: '#080808',
                    color: '#ffffff',
                    fontFamily: 'system-ui, sans-serif'
                }}>
                    <h1 style={{ fontSize: '3rem', marginBottom: '1rem', color: '#ef4444' }}>Something went wrong</h1>
                    <p style={{ color: '#a1a1aa', marginBottom: '2rem' }}>
                        An unexpected error occurred.
                    </p>
                    <button
                        onClick={() => reset()}
                        style={{
                            padding: '0.75rem 1.5rem',
                            backgroundColor: '#10b981',
                            color: '#000',
                            borderRadius: '0.75rem',
                            border: 'none',
                            cursor: 'pointer',
                            fontWeight: '500'
                        }}
                    >
                        Try again
                    </button>
                </div>
            </body>
        </html>
    );
}
