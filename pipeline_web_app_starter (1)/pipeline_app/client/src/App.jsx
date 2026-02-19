
import React, {useEffect, useMemo, useState} from 'react'
import axios from 'axios'
import dayjs from 'dayjs'
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd'

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000'

function currency(n){
  return new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP'}).format(n||0)
}

export default function App(){
  const [stages, setStages] = useState([])
  const [deals, setDeals] = useState([])
  const [region, setRegion] = useState('')
  const [metrics, setMetrics] = useState(null)

  async function load(){
    const s = await axios.get(`${API}/stages`).then(r=>r.data)
    setStages(s)
    const d = await axios.get(`${API}/deals`).then(r=>r.data)
    setDeals(d)
    refreshMetrics()
  }
  useEffect(()=>{ load() },[])

  const dealsByStage = useMemo(()=>{
    const map = {}
    stages.forEach(s=>map[s.id]=[])
    deals.filter(d=>!region || d.region===region).forEach(d=>{
      if(!map[d.stage_id]) map[d.stage_id]=[]
      map[d.stage_id].push(d)
    })
    return map
  },[deals, stages, region])

  async function onDragEnd(result){
    const {destination, source, draggableId} = result
    if(!destination) return
    if(destination.droppableId === source.droppableId) return
    await axios.post(`${API}/deals/${draggableId}/move`, {to_stage_id: destination.droppableId})
    const updated = await axios.get(`${API}/deals`).then(r=>r.data)
    setDeals(updated)
    refreshMetrics()
  }

  async function addDeal(stageId){
    const title = prompt('Deal title')
    if(!title) return
    const amount = Number(prompt('Value (£)')) || 0
    const company = prompt('Company (optional)') || ''
    const region = prompt('Region (e.g., North, South, Midlands, Scotland, Wales)') || ''
    const expected_close_date = prompt('Expected close date (YYYY-MM-DD)') || ''
    await axios.post(`${API}/deals`, {title, company, amount, region, stage_id: stageId, expected_close_date})
    const updated = await axios.get(`${API}/deals`).then(r=>r.data)
    setDeals(updated)
    refreshMetrics()
  }

  async function refreshMetrics(){
    const m = await axios.get(`${API}/metrics`).then(r=>r.data)
    setMetrics(m)
  }

  async function downloadWeekly(){
    const resp = await axios.post(`${API}/reports/weekly`).then(r=>r.data)
    const url = `${API}/${resp.file}`.replace(`${API}//`, `${API}/`)
    // simple fetch and download
    const blob = await fetch(`${API}/reports/` + resp.file.split('/').pop()).then(r=>r.blob()).catch(()=>null)
    if(!blob){
      // fallback: try direct link (if CORS static hosting not set up)
      alert('PDF generated on server at ' + resp.file)
      return
    }
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = resp.file.split('/').pop()
    link.click()
  }

  return (
    <div className='app'>
      <div className='topbar'>
        <h2>Pipeline</h2>
        <select className='filter' value={region} onChange={e=>setRegion(e.target.value)}>
          <option value=''>All regions</option>
          <option>North</option>
          <option>South</option>
          <option>Midlands</option>
          <option>Scotland</option>
          <option>Wales</option>
          <option>Ireland</option>
        </select>
        <button className='download' onClick={downloadWeekly}>Generate weekly PDF</button>
      </div>

      <DragDropContext onDragEnd={onDragEnd}>
        <div className='columns'>
          {stages.map(stage=> (
            <StageColumn key={stage.id} stage={stage} deals={dealsByStage[stage.id]||[]} onAdd={()=>addDeal(stage.id)} />
          ))}
        </div>
      </DragDropContext>

      {metrics && (
        <div style={{marginTop:8,fontSize:12,color:'#555'}}>
          Avg days open (all open deals): {metrics.daysOpenAvg.toFixed(1)}
        </div>
      )}
    </div>
  )
}

function StageColumn({stage, deals, onAdd}){
  // compute footer metrics client-side as a fallback
  const total = deals.reduce((a,b)=>a+Number(b.amount||0),0)
  const weighted = deals.reduce((a,b)=>a + Number(b.amount||0) * Number(stage.probability||0), 0)
  const avgDays = deals.length ? (deals.reduce((a,b)=> a + dayjs().diff(dayjs(b.stage_entered_at),'day'),0)/deals.length) : 0

  return (
    <div className='column'>
      <div className='column-header'>
        <div className='column-title'>{stage.name} <span className='badge'>{deals.length}</span></div>
        <button className='add-btn' onClick={onAdd}>+ Add</button>
      </div>
      <Droppable droppableId={String(stage.id)}>
        {(provided)=> (
          <div className='list' ref={provided.innerRef} {...provided.droppableProps}>
            {deals.map((deal, idx)=> (
              <Draggable draggableId={String(deal.id)} index={idx} key={deal.id}>
                {(prov)=> (
                  <div className='card' ref={prov.innerRef} {...prov.draggableProps} {...prov.dragHandleProps}>
                    <h4>{deal.title}</h4>
                    <div><strong>{currency(deal.amount)}</strong> • <small>{deal.company||'—'}</small></div>
                    <div><small>Region: {deal.region||'—'}</small></div>
                    <div><small>Days open: {dayjs().diff(dayjs(deal.created_at),'day')} • Days in stage: {dayjs().diff(dayjs(deal.stage_entered_at),'day')}</small></div>
                    <div><small>Expected close: {deal.expected_close_date? dayjs(deal.expected_close_date).format('YYYY-MM-DD'):'—'}</small></div>
                  </div>
                )}
              </Draggable>
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
      <div className='footer'>
        <div>Total: {currency(total)}</div>
        <div>Weighted: {currency(weighted)}</div>
        <div>Avg days in stage: {avgDays.toFixed(1)}</div>
      </div>
    </div>
  )
}
