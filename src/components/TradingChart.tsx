import React, { useEffect, useRef } from 'react';
import { createChart, ColorType, CandlestickSeries, LineSeries } from 'lightweight-charts';
import { Candle, IndicatorResult } from '../services/indicators';

interface ChartProps {
  data: Candle[];
  indicators: IndicatorResult;
}

export const TradingChart: React.FC<ChartProps> = ({ data, indicators }) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const candleSeriesRef = useRef<any>(null);
  const smaSeriesRef = useRef<any>(null);
  const ema9SeriesRef = useRef<any>(null);
  const ema21SeriesRef = useRef<any>(null);

  // Initialize chart once
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#141414' },
        textColor: '#d1d1d1',
      },
      grid: {
        vertLines: { color: '#2B2B2B' },
        horzLines: { color: '#2B2B2B' },
      },
      width: chartContainerRef.current.clientWidth,
      height: 500,
      timeScale: {
          timeVisible: true,
          secondsVisible: false,
      },
    });

    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });

    const smaSeries = chart.addSeries(LineSeries, {
      color: '#F27D26',
      lineWidth: 2,
      priceLineVisible: false,
    });

    const ema9Series = chart.addSeries(LineSeries, {
      color: '#2196f3',
      lineWidth: 1,
      priceLineVisible: false,
    });

    const ema21Series = chart.addSeries(LineSeries, {
      color: '#9c27b0',
      lineWidth: 1,
      priceLineVisible: false,
    });

    chartRef.current = chart;
    candleSeriesRef.current = candlestickSeries;
    smaSeriesRef.current = smaSeries;
    ema9SeriesRef.current = ema9Series;
    ema21SeriesRef.current = ema21Series;

    const handleResize = () => {
      chart.applyOptions({ width: chartContainerRef.current?.clientWidth });
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, []);

  // Update data when props change
  useEffect(() => {
    if (!candleSeriesRef.current || !smaSeriesRef.current || !ema9SeriesRef.current || !ema21SeriesRef.current || !data.length) return;

    candleSeriesRef.current.setData(data.map(c => ({
      time: c.time as any,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    })));

    const smaData = data.map((c, i) => ({
      time: c.time as any,
      value: indicators.sma200[i]
    })).filter(d => d.value !== null && d.value !== undefined);

    const ema9Data = data.map((c, i) => ({
      time: c.time as any,
      value: indicators.ema9[i]
    })).filter(d => d.value !== null && d.value !== undefined);

    const ema21Data = data.map((c, i) => ({
      time: c.time as any,
      value: indicators.ema21[i]
    })).filter(d => d.value !== null && d.value !== undefined);

    smaSeriesRef.current.setData(smaData);
    ema9SeriesRef.current.setData(ema9Data);
    ema21SeriesRef.current.setData(ema21Data);
  }, [data, indicators]);

  return <div ref={chartContainerRef} className="w-full h-[500px]" />;
};
