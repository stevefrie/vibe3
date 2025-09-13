import React from 'react';
import Game from './components/Game';

const App: React.FC = () => {
  const handleGameOver = (score: number) => {
    // This could be used to show a modal or send the score to a server
    console.log(`Game Over! Final Score: ${score}`);
  };

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center font-mono p-4">
      <header className="mb-4 text-center">
        <h1 className="text-4xl md:text-5xl font-bold text-cyan-400 tracking-widest uppercase" style={{ textShadow: '0 0 5px #0ff, 0 0 15px #0ff, 0 0 30px #0ff' }}>
          Missile Command
        </h1>
        <p className="text-red-500 text-lg tracking-[0.2em]">REACT EDITION</p>
      </header>
      <main>
        <Game onGameOver={handleGameOver} />
      </main>
      <footer className="mt-4 text-center text-gray-400 text-sm max-w-2xl">
        <p>Click on the screen to fire defensive missiles from the nearest armed base.</p>
        <p>Protect your structures from the incoming bombardment to survive.</p>
      </footer>
    </div>
  );
};

export default App;