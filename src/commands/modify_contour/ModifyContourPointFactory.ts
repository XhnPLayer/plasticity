import * as THREE from "three";
import c3d from '../../../build/Release/c3d.node';
import * as visual from '../../editor/VisualModel';
import { computeControlPointInfo, ControlPointInfo, inst2curve, normalizeCurve, point2point } from '../../util/Conversion';
import { GeometryFactory, NoOpError, ValidationError } from '../GeometryFactory';
import { MoveParams, RotateParams, ScaleParams } from "../translate/TranslateFactory";

export interface ModifyContourPointParams {
    get controlPointInfo(): ControlPointInfo[];
    set controlPoints(cps: number[] | visual.ControlPoint[]);
}

abstract class ModifyContourPointFactory extends GeometryFactory implements ModifyContourPointParams {
    private _controlPoints: number[] = [];
    get controlPoints(): number[] { return this._controlPoints }
    set controlPoints(controlPoints: visual.ControlPoint[] | number[]) {
        const result = [];
        for (const cp of controlPoints) {
            if (cp instanceof visual.ControlPoint) result.push(cp.index);
            else result.push(cp);
        }
        this._controlPoints = result;
    }

    async prepare(view: visual.SpaceInstance<visual.Curve3D>) {
        const inst = this.db.lookup(view);
        const curve = inst2curve(inst)!;
        const result = await normalizeCurve(curve);
        return result;
    }

    private _contour!: c3d.Contour3D;
    get contour(): c3d.Contour3D { return this._contour }
    set contour(inst: c3d.Contour3D | c3d.SpaceInstance | visual.SpaceInstance<visual.Curve3D>) {
        if (inst instanceof c3d.SpaceInstance) {
            const curve = inst2curve(inst);
            if (!(curve instanceof c3d.Contour3D)) throw new ValidationError("Contour expected");
            this._contour = curve;
        } else if (inst instanceof visual.SpaceInstance) {
            this.contour = this.db.lookup(inst);
            this.originalItem = inst;
            return;
        } else if (inst instanceof c3d.Contour3D) {
            this._contour = inst;
        } else throw new ValidationError("normalize the curve first: " + normalizeCurve.name);

        this._controlPointInfo = computeControlPointInfo(this.contour);
    }

    protected moveLimitPoint(point: 1 | 2, curve: c3d.Curve3D, info: ControlPointInfo, to: THREE.Vector3) {
        const cast = curve.Cast<c3d.Curve3D>(curve.IsA());
        if (cast instanceof c3d.PolyCurve3D) {
            if (cast instanceof c3d.Polyline3D) {
                cast.ChangePoint(point - 1, point2point(to));
            } else {
                if (point === 1) cast.ChangePoint(0, point2point(to));
                else cast.ChangePoint(cast.GetPoints().length - 1, point2point(to));
            }
            cast.Rebuild();
        } else if (cast instanceof c3d.Arc3D) {
            cast.SetLimitPoint(point, point2point(to));
        }
    }

    protected changePoint(curve: c3d.Curve3D, info: ControlPointInfo, to: THREE.Vector3) {
        const cast = curve.Cast<c3d.Curve3D>(curve.IsA());
        if (!(cast instanceof c3d.PolyCurve3D)) throw new Error();
        cast.ChangePoint(info.index, point2point(to));
        cast.Rebuild();
    }

    async calculate() {
        const { contour, controlPoints, controlPointInfo } = this;

        this.validate();

        const segments = contour.GetSegments();
        for (const controlPoint of controlPoints) {
            const info = controlPointInfo[controlPoint];
            const to = this.computeDestination(info);
            const active = segments[info.segmentIndex];
            let before = segments[info.segmentIndex - 1];
            if (before === undefined && contour.IsClosed()) before = segments[segments.length - 1];
            switch (info.limit) {
                case -1:
                    this.changePoint(active, info, to);
                    break;
                case 1:
                    this.moveLimitPoint(1, active, info, to);
                    if (before !== undefined) this.moveLimitPoint(2, before, info, to);
                    break;
                case 2:
                    this.moveLimitPoint(2, active, info, to);
                    break;
            }
        }

        const result = new c3d.Contour3D();
        for (const segment of segments) {
            result.AddCurveWithRuledCheck(segment, 1e-5, true);
        }

        return new c3d.SpaceInstance(result);
    }

    protected abstract computeDestination(info: ControlPointInfo): THREE.Vector3;
    protected abstract validate(): void;

    private _controlPointInfo!: ControlPointInfo[];
    get controlPointInfo() { return this._controlPointInfo }

    private _original!: visual.SpaceInstance<visual.Curve3D>;
    set originalItem(original: visual.SpaceInstance<visual.Curve3D>) { this._original = original }
    get originalItem() { return this._original }
}

export interface MoveContourPointParams extends ModifyContourPointParams, MoveParams {
    pivot: THREE.Vector3;
    move: THREE.Vector3;
}

export class MoveContourPointFactory extends ModifyContourPointFactory implements ModifyContourPointParams {
    pivot = new THREE.Vector3();
    move = new THREE.Vector3();

    private readonly to = new THREE.Vector3();

    protected computeDestination(info: ControlPointInfo) {
        return this.to.copy(info.origin).add(this.move);
    }

    validate() {
        if (this.move.manhattanLength() < 10e-5) throw new NoOpError();
    }
}

const identity = new THREE.Vector3(1, 1, 1);

export class ScaleContourPointFactory extends ModifyContourPointFactory implements ScaleParams {
    pivot = new THREE.Vector3();
    scale = new THREE.Vector3(1, 1, 1);

    private readonly to = new THREE.Vector3();

    protected computeDestination(info: ControlPointInfo) {
        return this.to.copy(info.origin).sub(this.pivot).multiply(this.scale).add(this.pivot);
    }

    validate() {
        if (this.scale.manhattanDistanceTo(identity) < 10e-5) throw new NoOpError();
    }
}

export class RotateContourPointFactory extends ModifyContourPointFactory implements RotateParams {
    pivot = new THREE.Vector3();
    axis = new THREE.Vector3(1, 0, 0);
    angle = 0;

    get degrees() { return THREE.MathUtils.radToDeg(this.angle) }
    set degrees(degrees: number) {
        this.angle = THREE.MathUtils.degToRad(degrees);
    }

    private readonly to = new THREE.Vector3();

    protected computeDestination(info: ControlPointInfo) {
        const { to, pivot, axis, angle } = this;
        return to.copy(info.origin).sub(pivot).applyAxisAngle(axis, angle).add(pivot);
    }

    validate() {
        if (Math.abs(this.angle) < 10e-5) throw new NoOpError();
    }
}